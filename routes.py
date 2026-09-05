import json
import mimetypes
import time
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

import psutil

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / "tools"
STATIC = {
    "/": ("html/index.html", "text/html"),
    "/favicon.ico": ("html/favicon.ico", "image/x-icon"),
    "/css/style.css": ("css/style.css", "text/css"),
    "/js/app.js": ("js/app.js", "application/javascript"),
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


def make_handler(dashboard_data_fn, tools_fn, run_script_fn, get_background_task_fn):
    """Return a Handler class that uses the provided callables."""
    class Handler(BaseHTTPRequestHandler):
        def send_json(self, obj, code=200):
            b=json.dumps(obj).encode()
            self.send_response(code); self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)

        def serve_file(self, rel_path, content_type):
            data=(ROOT / rel_path).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)


        def do_GET(self):
            path=urlparse(self.path).path
            if path in STATIC:
                self.serve_file(*STATIC[path]); return
            if path=="/api/tools":
                self.send_json(dashboard_data_fn()); return
            if path=="/api/stats":
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
            parts=path.strip("/").split("/")
            # Handle /api/tools/{id}/task/{task_id} for background task status
            if len(parts)==5 and parts[0]=="api" and parts[1]=="tools" and parts[3]=="task":
                task_info = get_background_task_fn(parts[4])
                if task_info:
                    self.send_json(task_info)
                else:
                    self.send_json({"error": "Task not found"}, 404)
                return
            if len(parts)==4 and parts[0]=="api" and parts[1]=="tools" and parts[3]=="icon":
                tool_dir=TOOLS/parts[2]
                tool_json=tool_dir/"tool.json"
                if tool_json.exists():
                    meta=json.loads(tool_json.read_text())
                    icon=meta.get("icon")
                    if icon:
                        icon_path=tool_dir/icon
                        if icon_path.exists():
                            ct,_=mimetypes.guess_type(icon)
                            self.serve_file(str(icon_path.relative_to(ROOT)), ct or "application/octet-stream")
                            return
                self.send_error(404); return
            self.send_error(404)

        def do_POST(self):
            path=urlparse(self.path).path
            parts=path.strip("/").split("/")
            if len(parts)==4 and parts[0]=="api" and parts[1]=="tools" and parts[3] in ("enable","disable"):
                from server import lock
                with lock:
                    ts={t["_id"]:t for t in tools_fn()}
                    t=ts.get(parts[2])
                    if not t: self.send_json({"error":"Unknown tool"},404); return
                    ok,out=run_script_fn(t,parts[3])
                self.send_json({"ok":ok,"output":out},200 if ok else 500); return
            self.send_error(404)

    return Handler
