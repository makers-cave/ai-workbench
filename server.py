#!/usr/bin/env python3
import json
import os
import subprocess
import threading
import time
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

def run_script(tool, action):
    if tool["kind"] != "docker":
        return False, "This entry is not a Docker service."
    script=TOOLS/tool["_id"]/(f"{action}.sh")
    if not script.exists():
        return False, f"Missing {script.name}"
    try:
        p=subprocess.run([str(script)], cwd=str(TOOLS/tool["_id"]), text=True,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        return p.returncode==0, p.stdout[-12000:]
    except subprocess.TimeoutExpired:
        return False, "Operation timed out after 180 seconds."

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
            return {"state":"stopped","detail":""}
        rows=[]
        for line in lines:
            try: rows.append(json.loads(line))
            except: pass
        if not rows:
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
        else:
            t["status"]={"state":"external","detail":""}
        out.append(t)
    return out

Handler = make_handler(dashboard_data, tools, run_script)

if __name__=="__main__":
    print(f"Local AI Hub: http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
