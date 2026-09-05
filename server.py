#!/usr/bin/env python3
import json
import os
import subprocess
import threading
import time
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path

from routes import make_handler

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / "tools"
CONFIG = ROOT / "config.env"

def load_env():
    if not CONFIG.exists():
        return
    for line in CONFIG.read_text().splitlines():
        line=line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k,v=line.split("=",1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env()
HOST=os.environ.get("HUB_HOST","0.0.0.0")
PORT=int(os.environ.get("HUB_PORT","80"))
lock=threading.Lock()

# Background task manager for long-running operations
_background_tasks = {}
_background_tasks_lock = threading.Lock()

def tools():
    result=[]
    for d in sorted(TOOLS.iterdir()):
        if not d.is_dir() or not (d/"tool.json").exists():
            continue
        try:
            meta=json.loads((d/"tool.json").read_text())
            meta["_id"]=d.name
            result.append(meta)
        except Exception as e:
            result.append({"_id":d.name,"name":d.name,"description":f"Invalid tool.json: {e}","kind":"error"})
    return result

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
                    "started_at": time.time()
                }
            
            # Run the script without timeout (background build can take 20-60 minutes)
            p=subprocess.run([str(script_path)], cwd=str(script_path.parent), text=True,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            
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
                "duration": time.time() - task["started_at"]
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
            # Get the most recent one
            tid, task = max(matching, key=lambda x: x[1]["started_at"])
            return {
                "task_id": tid,
                "tool_id": task["tool_id"],
                "action": task["action"],
                "status": task["status"],
                "output": task.get("output", ""),
                "returncode": task.get("returncode"),
                "duration": time.time() - task["started_at"]
            }
    return None

def run_script(tool, action):
    if tool["kind"] != "docker":
        return False, "This entry is not a Docker service."
    script=TOOLS/tool["_id"]/(f"{action}.sh")
    if not script.exists():
        return False, f"Missing {script.name}"
    
    # Run the script asynchronously for long operations
    task_id = _run_script_async(tool["_id"], action, script)
    
    return True, f"Operation started in background. Task ID: {task_id}"

def compose_status(tool):
    d=TOOLS/tool["_id"]
    if not (d/"compose.yaml").exists():
        return {"state":"unknown","detail":"No compose.yaml"}
    try:
        p=subprocess.run(["docker","compose","-f","compose.yaml","ps","--format","json"],
                         cwd=str(d), text=True, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, timeout=15)
        if p.returncode != 0:
            return {"state":"error","detail":p.stdout[-3000:]}
        lines=[x for x in p.stdout.splitlines() if x.strip()]
        if not lines:
            # Check if there's a background task running
            task = get_tool_background_task(tool["_id"], "enable")
            if task and task["status"] == "running":
                return {"state":"starting", detail:f"Build in progress ({int(task['duration'])}s)"}
            return {"state":"stopped","detail":""}
        rows=[]
        for line in lines:
            try: rows.append(json.loads(line))
            except: pass
        if not rows:
            # Check if there's a background task running
            task = get_tool_background_task(tool["_id"], "enable")
            if task and task["status"] == "running":
                return {"state":"starting", detail:f"Build in progress ({int(task['duration'])}s)"}
            return {"state":"stopped","detail":p.stdout}
        states=[str(x.get("State","")).lower() for x in rows]
        running=any(s in ("running","up") for s in states)
        return {"state":"running" if running else "stopped","detail":"; ".join(states)}
    except Exception as e:
        return {"state":"error","detail":str(e)}

def dashboard_data():
    out=[]
    for t in tools():
        if t.get("kind")=="docker":
            t["status"]=compose_status(t)
            # Add background task info if available
            task = get_tool_background_task(t["_id"])
            if task and task["status"] == "running":
                t["background_task"] = {
                    "task_id": task["task_id"],
                    "action": task["action"],
                    "status": task["status"],
                    "duration": int(task["duration"])
                }
        else:
            t["status"]={"state":"external","detail":""}
        out.append(t)
    return out

Handler = make_handler(dashboard_data, tools, run_script, get_background_task)

if __name__=="__main__":
    print(f"Local AI Hub: http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
