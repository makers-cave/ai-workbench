#!/usr/bin/env python3
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path

from routes import make_handler

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / "tools"
DATA = ROOT / "data"
UPLOADS = DATA / ".uploads"
CONFIG = ROOT / "config.env"
TOOL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
UPLOAD_MAX_BYTES = 500 * 1024 * 1024  # 500 MB
TOOL_URL_RE = re.compile(r"^https?://", re.IGNORECASE)

DEFAULT_SETTINGS = {
    "added_tools": [],
    "ui": {"theme": "dark"},
}


def load_env():
    if not CONFIG.exists():
        return
    for line in CONFIG.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
HOST = os.environ.get("HUB_HOST", "0.0.0.0")
PORT = int(os.environ.get("HUB_PORT", "80"))
lock = threading.Lock()

# Background task manager for long-running operations
_background_tasks = {}
_background_tasks_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Settings store (data/settings.json)
# ---------------------------------------------------------------------------

def _settings_path():
    DATA.mkdir(parents=True, exist_ok=True)
    return DATA / "settings.json"


def load_settings():
    path = _settings_path()
    merged = json.loads(json.dumps(DEFAULT_SETTINGS))  # deep copy
    if not path.exists():
        return merged
    try:
        data = json.loads(path.read_text())
    except Exception:
        return merged
    if not isinstance(data, dict):
        return merged

    added = None
    if isinstance(data.get("added_tools"), list):
        added = [x for x in data["added_tools"] if isinstance(x, str)]
    # Migrate from the previous hidden_tools key: invert -> added = all - hidden
    if added is None and isinstance(data.get("hidden_tools"), list):
        hidden = {x for x in data["hidden_tools"] if isinstance(x, str)}
        all_ids = [t["_id"] for t in _all_tools()]
        added = [i for i in all_ids if i not in hidden]
    if added is None:
        # First-ever run with an empty file: auto-add all currently discovered
        # tools so the dashboard doesn't go blank.
        added = [t["_id"] for t in _all_tools()]
    merged["added_tools"] = sorted(set(added))

    ui = data.get("ui")
    if isinstance(ui, dict):
        for k, v in ui.items():
            if isinstance(v, (str, int, float, bool)) or v is None:
                merged["ui"][k] = v
    return merged


def save_settings(data):
    path = _settings_path()
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(tmp, path)
    return data


def set_tool_added(tool_id, added):
    s = load_settings()
    cur = set(s.get("added_tools", []))
    if added:
        cur.add(tool_id)
    else:
        cur.discard(tool_id)
    s["added_tools"] = sorted(cur)
    save_settings(s)
    return s


# ---------------------------------------------------------------------------
# Tool discovery
# ---------------------------------------------------------------------------

def _all_tools():
    """Unfiltered tool discovery used by the Tools settings pane."""
    result = []
    if not TOOLS.exists():
        return result
    for d in sorted(TOOLS.iterdir()):
        if not d.is_dir() or not (d / "tool.json").exists():
            continue
        try:
            meta = json.loads((d / "tool.json").read_text())
            meta["_id"] = d.name
            result.append(meta)
        except Exception as e:
            result.append({
                "_id": d.name,
                "name": d.name,
                "description": f"Invalid tool.json: {e}",
                "kind": "error",
            })
    return result


def tools():
    """Public tool list, filtered to only the tools the user has added."""
    s = load_settings()
    added = set(s.get("added_tools", []))
    return [t for t in _all_tools() if t.get("_id") in added]


# ---------------------------------------------------------------------------
# Background task helpers (existing enable/disable flow)
# ---------------------------------------------------------------------------

def _run_script_async(tool_id, action, script_path):
    """Run a script in the background and track its status."""
    task_id = str(uuid.uuid4())

    def _run():
        try:
            with _background_tasks_lock:
                _background_tasks[task_id] = {
                    "tool_id": tool_id,
                    "action": action,
                    "status": "running",
                    "output": "",
                    "started_at": time.time(),
                }

            p = subprocess.run(
                [str(script_path)],
                cwd=str(script_path.parent),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )

            with _background_tasks_lock:
                _background_tasks[task_id]["status"] = "completed" if p.returncode == 0 else "failed"
                _background_tasks[task_id]["output"] = p.stdout[-12000:] if p.stdout else ""
                _background_tasks[task_id]["returncode"] = p.returncode
                _background_tasks[task_id]["completed_at"] = time.time()
        except Exception as e:
            with _background_tasks_lock:
                _background_tasks[task_id]["status"] = "failed"
                _background_tasks[task_id]["output"] = str(e)
                _background_tasks[task_id]["completed_at"] = time.time()

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return task_id


def _start_task(tool_id, action, fn):
    """Register a custom background task and run fn in a worker thread."""
    task_id = str(uuid.uuid4())
    with _background_tasks_lock:
        _background_tasks[task_id] = {
            "tool_id": tool_id,
            "action": action,
            "status": "running",
            "output": "",
            "started_at": time.time(),
        }

    def _run():
        try:
            output = fn()
            with _background_tasks_lock:
                _background_tasks[task_id]["status"] = "completed"
                _background_tasks[task_id]["output"] = (output or "")[-12000:]
                _background_tasks[task_id]["completed_at"] = time.time()
        except Exception as e:
            with _background_tasks_lock:
                _background_tasks[task_id]["status"] = "failed"
                _background_tasks[task_id]["output"] = f"{type(e).__name__}: {e}"
                _background_tasks[task_id]["completed_at"] = time.time()

    threading.Thread(target=_run, daemon=True).start()
    return task_id


def get_background_task(task_id):
    """Get the status of a background task."""
    with _background_tasks_lock:
        task = _background_tasks.get(task_id)
        if task:
            return {
                "task_id": task_id,
                "tool_id": task["tool_id"],
                "action": task["action"],
                "status": task["status"],
                "output": task.get("output", ""),
                "returncode": task.get("returncode"),
                "duration": time.time() - task["started_at"],
            }
    return None


def get_tool_background_task(tool_id, action=None):
    """Get the most recent background task for a tool."""
    with _background_tasks_lock:
        matching = [
            (tid, t) for tid, t in _background_tasks.items()
            if t["tool_id"] == tool_id and (action is None or t["action"] == action)
        ]
        if matching:
            tid, task = max(matching, key=lambda x: x[1]["started_at"])
            return {
                "task_id": tid,
                "tool_id": task["tool_id"],
                "action": task["action"],
                "status": task["status"],
                "output": task.get("output", ""),
                "returncode": task.get("returncode"),
                "duration": time.time() - task["started_at"],
            }
    return None


# ---------------------------------------------------------------------------
# Enable / disable
# ---------------------------------------------------------------------------

def run_script(tool, action):
    if tool["kind"] != "docker":
        return False, "This entry is not a Docker service."
    script = TOOLS / tool["_id"] / f"{action}.sh"
    if not script.exists():
        return False, f"Missing {script.name}"

    task_id = _run_script_async(tool["_id"], action, script)
    return True, f"Operation started in background. Task ID: {task_id}"


# ---------------------------------------------------------------------------
# Compose / status
# ---------------------------------------------------------------------------

def compose_status(tool):
    d = TOOLS / tool["_id"]
    if not (d / "compose.yaml").exists():
        return {"state": "unknown", "detail": "No compose.yaml"}
    try:
        p = subprocess.run(
            ["docker", "compose", "-f", "compose.yaml", "ps", "--format", "json"],
            cwd=str(d), text=True, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, timeout=15,
        )
        if p.returncode != 0:
            return {"state": "error", "detail": p.stdout[-3000:]}
        lines = [x for x in p.stdout.splitlines() if x.strip()]
        if not lines:
            task = get_tool_background_task(tool["_id"], "enable")
            if task and task["status"] == "running":
                return {"state": "starting", "detail": f"Build in progress ({int(task['duration'])}s)"}
            return {"state": "stopped", "detail": ""}
        rows = []
        for line in lines:
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
        if not rows:
            task = get_tool_background_task(tool["_id"], "enable")
            if task and task["status"] == "running":
                return {"state": "starting", "detail": f"Build in progress ({int(task['duration'])}s)"}
            return {"state": "stopped", "detail": p.stdout}
        states = [str(x.get("State", "")).lower() for x in rows]
        running = any(s in ("running", "up") for s in states)
        return {"state": "running" if running else "stopped", "detail": "; ".join(states)}
    except Exception as e:
        return {"state": "error", "detail": str(e)}


# ---------------------------------------------------------------------------
# Dashboard aggregation
# ---------------------------------------------------------------------------

def dashboard_data():
    out = []
    for t in tools():
        if t.get("kind") == "docker":
            t["status"] = compose_status(t)
            task = get_tool_background_task(t["_id"])
            if task and task["status"] == "running":
                t["background_task"] = {
                    "task_id": task["task_id"],
                    "action": task["action"],
                    "status": task["status"],
                    "duration": int(task["duration"]),
                }
        else:
            t["status"] = {"state": "external", "detail": ""}
        out.append(t)
    return out


# ---------------------------------------------------------------------------
# Settings pane tool list (full, with hidden flag)
# ---------------------------------------------------------------------------

def settings_tools():
    s = load_settings()
    added = set(s.get("added_tools", []))
    out = []
    for t in _all_tools():
        t = dict(t)
        t["added"] = t.get("_id") in added
        if t.get("kind") == "docker":
            t["status"] = compose_status(t)
            task = get_tool_background_task(t["_id"])
            if task and task["status"] == "running":
                t["background_task"] = {
                    "task_id": task["task_id"],
                    "action": task["action"],
                    "status": task["status"],
                    "duration": int(task["duration"]),
                }
        else:
            t["status"] = {"state": "external", "detail": ""}
        out.append(t)
    return out


# ---------------------------------------------------------------------------
# Install / upload / delete
# ---------------------------------------------------------------------------

def _safe_extract_zip(zip_path, dest_dir):
    """Extract a zip into dest_dir safely (no path traversal)."""
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    if not zipfile.is_zipfile(str(zip_path)):
        raise ValueError("Not a valid zip file")
    base = dest_dir.resolve()
    with zipfile.ZipFile(str(zip_path)) as zf:
        for member in zf.infolist():
            name = member.filename
            # Reject absolute paths and parent traversal
            if name.startswith("/") or ".." in Path(name).parts:
                raise ValueError(f"Unsafe path in zip: {name}")
            target = (base / name).resolve()
            if not str(target).startswith(str(base) + os.sep) and target != base:
                raise ValueError(f"Unsafe path in zip: {name}")
        zf.extractall(str(dest_dir))


def install_tool_from_url(tool_id, url):
    if not TOOL_ID_RE.match(tool_id):
        raise ValueError("Invalid tool id")
    if not TOOL_URL_RE.match(url or ""):
        raise ValueError("Only http(s) URLs are supported")
    target = TOOLS / tool_id
    if target.exists():
        raise ValueError(f"Tool '{tool_id}' already exists. Use replace mode or delete it first.")

    def _work():
        DATA.mkdir(parents=True, exist_ok=True)
        UPLOADS.mkdir(parents=True, exist_ok=True)
        staging_zip = UPLOADS / f"install-{tool_id}-{int(time.time())}.zip"
        req = urllib.request.Request(url, headers={"User-Agent": "ai-workbench/1.0"})
        with urllib.request.urlopen(req, timeout=600) as resp, open(staging_zip, "wb") as out:
            shutil.copyfileobj(resp, out)
        try:
            target.mkdir(parents=True, exist_ok=False)
            try:
                _safe_extract_zip(staging_zip, target)
            except Exception:
                shutil.rmtree(target, ignore_errors=True)
                raise
        finally:
            try:
                staging_zip.unlink()
            except Exception:
                pass
        return f"Installed '{tool_id}' from {url}"

    return _start_task(tool_id, "install", _work)


def install_tool_from_upload(tool_id, zip_path, mode):
    if not TOOL_ID_RE.match(tool_id):
        raise ValueError("Invalid tool id")
    if mode not in ("new", "replace"):
        raise ValueError("mode must be 'new' or 'replace'")
    if not zipfile.is_zipfile(str(zip_path)):
        raise ValueError("Not a valid zip file")
    target = TOOLS / tool_id
    if target.exists():
        if mode != "replace":
            raise ValueError(f"Tool '{tool_id}' already exists. Use replace mode to overwrite.")
    else:
        if mode == "replace":
            raise ValueError(f"Tool '{tool_id}' does not exist; use mode 'new' to create it.")

    def _work():
        if target.exists():
            # Wipe existing contents (keep the dir itself)
            for child in target.iterdir():
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    try:
                        child.unlink()
                    except Exception:
                        pass
        else:
            target.mkdir(parents=True, exist_ok=False)
        _safe_extract_zip(zip_path, target)
        return f"Uploaded zip into '{tool_id}' (mode={mode})"

    return _start_task(tool_id, "upload", _work)


def delete_tool(tool_id, delete_data):
    if not TOOL_ID_RE.match(tool_id):
        raise ValueError("Invalid tool id")
    target = TOOLS / tool_id
    if not target.exists():
        raise ValueError(f"Tool '{tool_id}' does not exist")

    def _work():
        # Make sure it isn't running
        try:
            subprocess.run(
                ["docker", "compose", "-f", "compose.yaml", "down", "--remove-orphans"],
                cwd=str(target), text=True,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
            )
        except Exception:
            pass
        shutil.rmtree(target, ignore_errors=True)
        msg = f"Removed tools/{tool_id}/"
        if delete_data:
            data_dir = DATA / tool_id
            if data_dir.exists():
                shutil.rmtree(data_dir, ignore_errors=True)
                msg += f" and data/{tool_id}/"
        # Drop from added list too (if it was there)
        s = load_settings()
        if tool_id in s.get("added_tools", []):
            s["added_tools"] = [x for x in s["added_tools"] if x != tool_id]
            save_settings(s)
        return msg

    return _start_task(tool_id, "delete", _work)


# ---------------------------------------------------------------------------
# Bootstrap handler
# ---------------------------------------------------------------------------

Handler = make_handler(
    dashboard_data,
    tools,
    run_script,
    get_background_task,
    load_settings=load_settings,
    save_settings=save_settings,
    set_tool_added=set_tool_added,
    settings_tools=settings_tools,
    install_tool_from_url=install_tool_from_url,
    install_tool_from_upload=install_tool_from_upload,
    delete_tool=delete_tool,
    UPLOAD_MAX_BYTES=UPLOAD_MAX_BYTES,
)

if __name__ == "__main__":
    print(f"Local AI Hub: http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
