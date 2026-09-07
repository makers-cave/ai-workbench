import json
import mimetypes
import re
import time
import threading
import uuid
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import psutil

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / "tools"
DATA = ROOT / "data"
UPLOADS = DATA / ".uploads"
REPO = DATA / "repo.json"

STATIC = {
    "/": ("html/index.html", "text/html"),
    "/favicon.ico": ("html/favicon.ico", "image/x-icon"),
    "/css/style.css": ("css/style.css", "text/css"),
    "/js/app.js": ("js/app.js", "application/javascript"),
    "/logo.png": ("html/logo.png", "image/png"),
}

GPU_BUSY = Path("/sys/class/drm/card1/device/gpu_busy_percent")
GPU_VRAM_USED = Path("/sys/class/drm/card1/device/mem_info_vram_used")
GPU_VRAM_TOTAL = Path("/sys/class/drm/card1/device/mem_info_vram_total")


class SystemStats:
    def __init__(self):
        self._prev_cpu = None
        self._lock = threading.Lock()

    def _read_cpu(self):
        with open("/proc/stat") as f:
            parts = f.readline().split()
        vals = list(map(int, parts[1:]))
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        total = sum(vals)
        return idle, total

    def collect(self):
        idle, total = self._read_cpu()
        with self._lock:
            if self._prev_cpu:
                pi, pt = self._prev_cpu
                d_idle = idle - pi
                d_total = total - pt
                cpu_pct = round((1 - d_idle / d_total) * 100, 1) if d_total else 0
            else:
                cpu_pct = 0
            self._prev_cpu = (idle, total)

        mem = psutil.virtual_memory()
        ram_pct = mem.percent

        gpu_busy = 0
        vram_used = 0
        vram_total = 0
        try:
            gpu_busy = int(GPU_BUSY.read_text().strip())
            vram_used = int(GPU_VRAM_USED.read_text().strip())
            vram_total = int(GPU_VRAM_TOTAL.read_text().strip())
        except Exception:
            pass

        vram_pct = round(vram_used / vram_total * 100, 1) if vram_total else 0
        vram_used_gb = round(vram_used / (1024**3), 1)
        vram_total_gb = round(vram_total / (1024**3), 1)

        temp = 0
        try:
            temp = int(Path("/sys/class/hwmon/hwmon14/temp1_input").read_text().strip()) // 1000
        except Exception:
            pass

        return {
            "cpu": cpu_pct,
            "ram": ram_pct,
            "gpu": gpu_busy,
            "vram": vram_pct,
            "vram_used": vram_used_gb,
            "vram_total": vram_total_gb,
            "temp": temp,
        }


_stats = SystemStats()


def _parse_multipart(content_type, body, max_bytes):
    """Minimal multipart/form-data parser.

    Returns list of (name, filename, content_type, bytes). Supports one or more
    file fields. Aborts by raising ValueError if the body exceeds max_bytes.
    """
    m = re.search(r"boundary=(?:\"([^\"]+)\"|([^;]+))", content_type or "", re.IGNORECASE)
    if not m:
        raise ValueError("Missing multipart boundary")
    boundary = (m.group(1) or m.group(2)).strip()
    delim = ("--" + boundary).encode()
    sep = ("\r\n--" + boundary).encode()
    # Strip leading boundary
    if not body.startswith(delim):
        raise ValueError("Malformed multipart body")
    body = body[len(delim):]
    if body.startswith(b"--\r\n"):
        return []
    parts = body.split(sep)
    out = []
    for raw in parts:
        if raw.endswith(b"--\r\n"):
            raw = raw[:-4]
        elif raw.endswith(b"--"):
            raw = raw[:-2]
        if not raw or raw == b"\r\n":
            continue
        # Split headers and body
        if b"\r\n\r\n" not in raw:
            continue
        head, _, data = raw.partition(b"\r\n\r\n")
        if data.endswith(b"\r\n"):
            data = data[:-2]
        header_lines = head.decode("utf-8", "replace").split("\r\n")
        cd = next((h for h in header_lines if h.lower().startswith("content-disposition")), "")
        ct = next((h for h in header_lines if h.lower().startswith("content-type")), "")
        m_name = re.search(r'name="([^"]+)"', cd, re.IGNORECASE)
        m_file = re.search(r'filename="([^"]*)"', cd, re.IGNORECASE)
        if not m_name:
            continue
        name = m_name.group(1)
        filename = m_file.group(1) if m_file else ""
        part_ct = ct.split(":", 1)[1].strip() if ":" in ct else "text/plain"
        out.append((name, filename, part_ct, data))
        if sum(len(p[3]) for p in out) > max_bytes:
            raise ValueError("Upload too large")
    return out


def make_handler(
    dashboard_data_fn,
    tools_fn,
    run_script_fn,
    get_background_task_fn,
    *,
    load_settings=None,
    save_settings=None,
    set_tool_added=None,
    settings_tools=None,
    install_tool_from_url=None,
    install_tool_from_upload=None,
    preview_tool_from_upload=None,
    delete_tool=None,
    UPLOAD_MAX_BYTES=500 * 1024 * 1024,
):
    """Return a Handler class that uses the provided callables."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            # Quieter logs; keep the default format available if needed.
            return

        # ---- helpers ----
        def send_json(self, obj, code=200):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def send_error_json(self, msg, code=400):
            self.send_json({"ok": False, "error": msg}, code)

        def serve_file(self, rel_path, content_type):
            data = (ROOT / rel_path).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def read_json_body(self):
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length <= 0:
                return {}
            raw = self.rfile.read(length)
            try:
                return json.loads(raw.decode("utf-8"))
            except Exception:
                return {}

        # ---- GET ----
        def do_GET(self):
            path = urlparse(self.path).path
            if path in STATIC:
                self.serve_file(*STATIC[path])
                return
            if path == "/api/tools":
                self.send_json(dashboard_data_fn())
                return
            if path == "/api/settings":
                self.send_json(load_settings() if load_settings else {})
                return
            if path == "/api/settings/tools":
                self.send_json(settings_tools() if settings_tools else [])
                return
            if path == "/api/repo":
                # Tool storage / catalog. Falls back to {"tools":[]} if the
                # file is missing or malformed so the dashboard still loads.
                try:
                    payload = json.loads(REPO.read_text(encoding="utf-8"))
                    if not isinstance(payload, dict):
                        payload = {}
                    payload.setdefault("tools", [])
                except Exception:
                    payload = {"tools": []}
                self.send_json(payload)
                return
            if path == "/api/stats":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                try:
                    while True:
                        data = _stats.collect()
                        line = f"data: {json.dumps(data)}\n\n"
                        self.wfile.write(line.encode())
                        self.wfile.flush()
                        time.sleep(1)
                except Exception:
                    return
            parts = path.strip("/").split("/")
            if len(parts) == 5 and parts[0] == "api" and parts[1] == "tools" and parts[3] == "task":
                task_info = get_background_task_fn(parts[4])
                if task_info:
                    self.send_json(task_info)
                else:
                    self.send_json({"error": "Task not found"}, 404)
                return
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "tools" and parts[3] == "icon":
                tool_dir = TOOLS / parts[2]
                tool_json = tool_dir / "tool.json"
                if tool_json.exists():
                    meta = json.loads(tool_json.read_text())
                    icon = meta.get("icon")
                    if icon:
                        icon_path = tool_dir / icon
                        if icon_path.exists():
                            ct, _ = mimetypes.guess_type(icon)
                            self.serve_file(str(icon_path.relative_to(ROOT)), ct or "application/octet-stream")
                            return
                self.send_error(404)
                return
            self.send_error(404)

        # ---- POST ----
        def do_POST(self):
            path = urlparse(self.path).path
            parts = path.strip("/").split("/")

            # POST /api/tools/install  body={id,url}
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "tools" and parts[2] == "install":
                if not install_tool_from_url:
                    self.send_error_json("install not supported", 500)
                    return
                body = self.read_json_body()
                tool_id = (body.get("id") or "").strip()
                url = (body.get("url") or "").strip()
                try:
                    task_id = install_tool_from_url(tool_id, url)
                except ValueError as e:
                    self.send_error_json(str(e), 400)
                    return
                except Exception as e:
                    self.send_error_json(f"Failed to start install: {e}", 500)
                    return
                self.send_json({"ok": True, "output": f"Task ID: {task_id}"})
                return

            # POST /api/tools/preview  multipart: file -> { valid, id, name, ... }
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "tools" and parts[2] == "preview":
                if not preview_tool_from_upload:
                    self.send_error_json("preview not supported", 500)
                    return
                length = int(self.headers.get("Content-Length", "0") or "0")
                if length <= 0:
                    self.send_error_json("Empty body", 400)
                    return
                if length > UPLOAD_MAX_BYTES + 4096:
                    self.send_error_json(f"Upload too large (max {UPLOAD_MAX_BYTES} bytes)", 413)
                    return
                body = self.rfile.read(length)
                try:
                    fields = _parse_multipart(self.headers.get("Content-Type", ""), body, UPLOAD_MAX_BYTES)
                except ValueError as e:
                    self.send_error_json(str(e), 400)
                    return
                file_payload = None
                for n, fn, ct, data in fields:
                    if fn and (n == "file" or n == "file:"):
                        file_payload = (fn, ct, data)
                        break
                if not file_payload:
                    self.send_error_json("Missing file field", 400)
                    return
                _, _, file_bytes = file_payload
                DATA.mkdir(parents=True, exist_ok=True)
                UPLOADS.mkdir(parents=True, exist_ok=True)
                staging = UPLOADS / f"preview-{uuid.uuid4().hex}.zip"
                staging.write_bytes(file_bytes)
                try:
                    try:
                        meta = preview_tool_from_upload(staging)
                    except ValueError as e:
                        self.send_error_json(str(e), 400)
                        return
                    except Exception as e:
                        self.send_error_json(f"Preview failed: {e}", 500)
                        return
                    meta = dict(meta)
                    meta["ok"] = True
                    self.send_json(meta)
                finally:
                    # Preview should not leave files behind.
                    try:
                        staging.unlink()
                    except Exception:
                        pass
                return

            # POST /api/tools/upload  multipart: id, mode, file
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "tools" and parts[2] == "upload":
                if not install_tool_from_upload:
                    self.send_error_json("upload not supported", 500)
                    return
                length = int(self.headers.get("Content-Length", "0") or "0")
                if length <= 0:
                    self.send_error_json("Empty body", 400)
                    return
                if length > UPLOAD_MAX_BYTES + 4096:
                    self.send_error_json(f"Upload too large (max {UPLOAD_MAX_BYTES} bytes)", 413)
                    return
                body = self.rfile.read(length)
                try:
                    fields = _parse_multipart(self.headers.get("Content-Type", ""), body, UPLOAD_MAX_BYTES)
                except ValueError as e:
                    self.send_error_json(str(e), 400)
                    return
                def _is_file_field(item):
                    # A field is a file field when the multipart parser captured a
                    # non-empty filename (i.e. it had a Content-Disposition with
                    # filename="..."). The field name itself stays "file" etc.
                    return bool(item[1])

                form = {}
                file_payload = None
                for n, fn, ct, v in fields:
                    if _is_file_field((n, fn, ct, v)):
                        if file_payload is None:
                            file_payload = (fn, ct, v)
                    else:
                        form[n] = v
                tool_id = (form.get("id") or "").decode("utf-8", "replace").strip() if isinstance(form.get("id"), (bytes, bytearray)) else str(form.get("id", "")).strip()
                mode = (form.get("mode") or b"new").decode("utf-8", "replace").strip() if isinstance(form.get("mode"), (bytes, bytearray)) else str(form.get("mode", "new")).strip()
                if not file_payload:
                    self.send_error_json("Missing file field", 400)
                    return
                _, _, file_bytes = file_payload
                DATA.mkdir(parents=True, exist_ok=True)
                UPLOADS.mkdir(parents=True, exist_ok=True)
                staging = UPLOADS / f"upload-{uuid.uuid4().hex}.zip"
                staging.write_bytes(file_bytes)
                try:
                    task_id = install_tool_from_upload(tool_id, staging, mode)
                except ValueError as e:
                    try:
                        staging.unlink()
                    except Exception:
                        pass
                    self.send_error_json(str(e), 400)
                    return
                except Exception as e:
                    try:
                        staging.unlink()
                    except Exception:
                        pass
                    self.send_error_json(f"Failed to start upload: {e}", 500)
                    return
                # Worker is responsible for keeping/extracting; clean up zip on completion
                # via a small wrapper: the worker copies bytes from staging, so we can
                # unlink after a small delay only if the worker already moved it. Since
                # the worker extracts from the path in place, leave it for the worker to
                # delete in a follow-up (we'll add cleanup below).
                self._schedule_cleanup(staging)
                self.send_json({"ok": True, "output": f"Task ID: {task_id}"})
                return

            # POST /api/tools/{id}/visibility  body={hidden:bool}
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "tools" and parts[3] == "visibility":
                if not set_tool_added:
                    self.send_error_json("visibility not supported", 500)
                    return
                body = self.read_json_body()
                added = bool(body.get("added"))
                try:
                    s = set_tool_added(parts[2], added)
                except Exception as e:
                    self.send_error_json(str(e), 400)
                    return
                self.send_json({"ok": True, "added_tools": s.get("added_tools", [])})
                return

            # POST /api/tools/{id}/{enable|disable}
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "tools" and parts[3] in ("enable", "disable"):
                from server import lock
                with lock:
                    ts = {t["_id"]: t for t in tools_fn()}
                    t = ts.get(parts[2])
                    if not t:
                        self.send_json({"error": "Unknown tool"}, 404)
                        return
                    ok, out = run_script_fn(t, parts[3])
                self.send_json({"ok": ok, "output": out}, 200 if ok else 500)
                return

            self.send_error(404)

        # ---- PUT / DELETE ----
        def do_PUT(self):
            path = urlparse(self.path).path
            if path == "/api/settings":
                if not save_settings:
                    self.send_error_json("settings not supported", 500)
                    return
                body = self.read_json_body()
                # Only allow known keys
                current = load_settings() if load_settings else {"added_tools": [], "ui": {}}
                if "added_tools" in body and isinstance(body["added_tools"], list):
                    current["added_tools"] = [str(x) for x in body["added_tools"]]
                if "ui" in body and isinstance(body["ui"], dict):
                    for k, v in body["ui"].items():
                        if isinstance(v, (str, int, float, bool)) or v is None:
                            current["ui"][k] = v
                self.send_json(save_settings(current))
                return
            self.send_error(404)

        def do_DELETE(self):
            path = urlparse(self.path).path
            parts = path.strip("/").split("/")
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "tools":
                if not delete_tool:
                    self.send_error_json("delete not supported", 500)
                    return
                qs = parse_qs(urlparse(self.path).query)
                delete_data = (qs.get("delete_data", ["0"])[0] in ("1", "true", "yes"))
                try:
                    task_id = delete_tool(parts[2], delete_data)
                except ValueError as e:
                    self.send_error_json(str(e), 400)
                    return
                except Exception as e:
                    self.send_error_json(f"Failed to start delete: {e}", 500)
                    return
                self.send_json({"ok": True, "output": f"Task ID: {task_id}"})
                return
            self.send_error(404)

        # ---- internals ----
        def _schedule_cleanup(self, path):
            # Best-effort delayed delete of the uploaded zip once the worker has
            # had time to read it. The worker extracts from the same path, so
            # we keep the file around for a few minutes to avoid races.
            def _cleanup():
                time.sleep(120)
                try:
                    Path(path).unlink()
                except Exception:
                    pass

            threading.Thread(target=_cleanup, daemon=True).start()

    return Handler
