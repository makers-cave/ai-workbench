# AI Workbench

A Docker Compose-based local AI launcher/dashboard for CachyOS + AMD Ryzen AI Max+ 395.

## Design

- Root contains the control plane.
- Each `tools/<tool>/` directory is self-contained:
  - `tool.json` — dashboard metadata
  - `compose.yaml` — Docker Compose definition
  - `enable.sh` — start/update the tool
  - `disable.sh` — stop/remove the tool
- `server.py` discovers tools automatically; adding a new tool does not require changing the dashboard.
- Persistent data lives under `data/<tool>/`.
- The dashboard runs on the host and invokes the per-tool scripts. This avoids giving the dashboard container direct Docker-socket access.

## Current tool entries

| Tool | Port | Type | Notes |
|---|---:|---|---|
| llama.cpp | 8001 | Docker | ROCm; put a GGUF at `data/llama-cpp/models/model.gguf` |
| Open WebUI | 3000 | Docker | Recommended front-end for local models |
| InvokeAI | 9090 | Docker | ROCm image |
| ComfyUI | 8188 | Docker | Ryzen AI Max+ 395 ROCm settings are experimental |
| OpenHands | 3001 | Docker | Requires Docker socket for its agent sandbox |
| Cursor | — | External | Linux desktop AppImage; not a web/Docker service |

Cursor is deliberately represented as an external tool rather than pretending a desktop IDE can be meaningfully containerized. The dashboard can still show a link/instructions for it.

## Quick start

```bash
./setup.sh
```

Then log out/in (or run `newgrp docker`) if setup added your account to the `docker` group.

Start the dashboard:

```bash
./run.sh
```

Open:

http://127.0.0.1:8080

Install a tool from the dashboard. For CLI use:

```bash
./tools/openwebui/enable.sh
./tools/openwebui/disable.sh
```

## Important AMD note

The Ryzen AI Max+ 395 exposes an integrated RDNA 3.5 GPU. ROCm container access normally requires `/dev/kfd` and `/dev/dri`; this project centralizes those settings in `config.env`. Some applications have better Ryzen/APU support than others.

The dashboard is intentionally simple. It is a control plane, not an authentication boundary. Keep it bound to `127.0.0.1` unless you add authentication and TLS.
