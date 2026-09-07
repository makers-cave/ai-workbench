# Adding a new tool

Every tool in this project is a **self-contained folder** under [`tools/`](.). The dashboard (`server.py`) discovers them automatically by scanning for `tool.json` files, so adding a new tool does **not** require any change to the dashboard code.

This guide walks through the exact steps to add a new tool — using `my-tool` as a placeholder name throughout. Replace it with the real slug of the tool you're adding (e.g. `kokoro`, `litellm`, `qdrant`).

---

## 1. Conventions at a glance

A tool directory follows these conventions:

| Path | Purpose | Required? |
|---|---|---|
| `tools/<id>/tool.json` | Dashboard metadata (name, description, URL, icon, notes) | **Yes** |
| `tools/<id>/compose.yaml` | Docker Compose service definition | **Yes** (for `kind: docker`) |
| `tools/<id>/enable.sh` | Start/update the tool | **Yes** |
| `tools/<id>/disable.sh` | Stop the tool | **Yes** |
| `tools/<id>/README.md` | Free-form notes specific to this tool | Optional but recommended |
| `tools/<id>/Dockerfile`, `clone.sh`, etc. | Anything the compose service needs to build | Optional |
| `data/<id>/` | Persistent data on the host (created at enable time) | Convention |
| `config.env` (root) | User-configurable ports and secrets | Updated when the tool needs new env vars |

The `<id>` slug **must** be:

- Lowercase, with hyphens (e.g. `llama-cpp`, `stable-diffusion`, `openwebui`).
- Unique across all tools — it becomes the directory name, the `data/` folder, and the key the dashboard uses to look up the tool.

---

## 2. Create the folder

```bash
mkdir -p tools/my-tool
```

Everything for the tool goes inside this folder. The dashboard will pick it up on the next request.

---

## 3. Add `tool.json` (dashboard metadata)

Create [`tools/my-tool/tool.json`](my-tool/tool.json). Schema:

```json
{
  "name": "My Tool",
  "description": "One-sentence description shown on the dashboard card.",
  "kind": "docker",
  "url": "http://127.0.0.1:12345",
  "icon": "https://example.com/icon.png",
  "notes": "Optional short note shown to the user (defaults, first-run quirks, etc.)."
}
```

Field reference:

- **`name`** — Human-friendly display name (e.g. `"Open WebUI"`).
- **`description`** — Short tagline; appears under the name on the dashboard card.
- **`kind`** — Currently `"docker"` for everything in this repo. Reserved for future kinds (e.g. `"host"` for an AppImage).
- **`url`** — The URL the dashboard's **Open** button launches. Bind to `127.0.0.1`; the dashboard is intentionally not an auth boundary.
- **`icon`** — PNG/SVG URL. The convention is to point at a public icon CDN (e.g. [`homarr-labs/dashboard-icons`](https://github.com/homarr-labs/dashboard-icons) or [`selfhst/icons`](https://github.com/selfhst/icons)).
- **`notes`** *(optional)* — Free-form text shown on the card; use it for first-run warnings, port info, model prerequisites, etc.

Pick a port that does **not** collide with an existing tool (see [`config.env.example`](../config.env.example)).

---

## 4. Add `compose.yaml`

Create [`tools/my-tool/compose.yaml`](my-tool/compose.yaml). The standard pattern is:

```yaml
services:
  my-tool:
    image: ghcr.io/example/my-tool:latest
    container_name: local-ai-my-tool
    restart: unless-stopped
    ports:
      - "${MY_TOOL_PORT:-12345}:12345"
    volumes:
      - ../../data/my-tool:/data
    environment:
      # Anything user-tunable should default via :- so it works without config.env
      MY_TOOL_SECRET: ${MY_TOOL_SECRET:-change-me-local-ai-hub}
```

### Required conventions

- **`container_name`** — prefix with `local-ai-<id>` so containers from this hub are easy to spot (`docker ps | grep local-ai`).
- **`restart: unless-stopped`** — matches the rest of the repo.
- **Ports** — always use the `${MY_TOOL_PORT:-<default>}:<container-port>` form so the user can override the host port in `config.env` without editing the compose file.
- **Volumes** — bind host paths to `../../data/my-tool/...` (relative to the tool folder). Persist anything the container writes, including caches, databases, model weights, config.
- **Environment variables** — use `${VAR:-default}` everywhere; the `enable.sh` script sources `config.env` before invoking compose.

### AMD ROCm GPU passthrough (Ryzen AI Max+ 395 / RDNA 3.5)

If the tool needs the iGPU, add the standard block used by every other GPU tool in this repo:

```yaml
    devices:
      - /dev/kfd:/dev/kfd
      - /dev/dri:/dev/dri
    ipc: host
    group_add:
      - video
      - render
    security_opt:
      - seccomp:unconfined
    environment:
      HSA_OVERRIDE_GFX_VERSION: ${HSA_OVERRIDE_GFX_VERSION:-11.5.1}
      HIP_VISIBLE_DEVICES: ${HIP_VISIBLE_DEVICES:-0}
```

Reference implementations: [`tools/comfyui/compose.yaml`](comfyui/compose.yaml), [`tools/stable-diffusion/compose.yaml`](stable-diffusion/compose.yaml), [`tools/invokeai/compose.yaml`](invokeai/compose.yaml), [`tools/llama-cpp/compose.yaml`](llama-cpp/compose.yaml).

### Building from a local Dockerfile

If the image must be built locally (no upstream ROCm image, like Stable Diffusion), use:

```yaml
services:
  my-tool:
    build:
      context: .
      dockerfile: Dockerfile
    image: local-ai/my-tool:rocm
    # ... rest as above
```

Reference: [`tools/stable-diffusion/compose.yaml`](stable-diffusion/compose.yaml).

---

## 5. Add `enable.sh`

Create [`tools/my-tool/enable.sh`](my-tool/enable.sh):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -f ../../config.env ]]; then
  set -a; . ../../config.env; set +a
fi
mkdir -p ../../data/my-tool
docker compose pull
docker compose up -d
docker compose ps
```

Required conventions:

- Shebang `#!/usr/bin/env bash` and `set -euo pipefail`.
- `cd "$(dirname "$0")"` so the script always runs against its own compose file regardless of cwd.
- Source `../../config.env` (if present) so user overrides reach the compose file.
- `mkdir -p ../../data/<id>` so the bind-mount target exists on first run.
- `docker compose pull` then `docker compose up -d` — pull first so updated images take effect.
- `docker compose ps` at the end so the user sees the container status in the terminal.

If the tool builds from a local Dockerfile, swap `docker compose pull` for `docker compose build <service>` (see [`tools/stable-diffusion/enable.sh`](stable-diffusion/enable.sh)).

Make it executable:

```bash
chmod +x tools/my-tool/enable.sh
```

---

## 6. Add `disable.sh`

Create [`tools/my-tool/disable.sh`](my-tool/disable.sh):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose down
```

Then:

```bash
chmod +x tools/my-tool/disable.sh
```

`docker compose down` is sufficient — it stops the container and removes the anonymous networks. Persistent data under `../../data/<id>/` is **not** deleted; users keep state across restarts and `disable`/`enable` cycles. (If the tool truly needs to wipe data, do it explicitly in `disable.sh` after the down, but that is rare.)

---

## 7. (Optional) Add `README.md`

A short per-tool README is the right place to document anything that's awkward to fit in `tool.json`.notes — environment variable cheatsheets, model download steps, known issues, etc. See:

- [`tools/comfyui/README.md`](comfyui/README.md) — small note explaining why the image is a placeholder.
- [`tools/openhands/README.md`](openhands/README.md) — security note about `/var/run/docker.sock`.
- [`tools/stable-diffusion/README.md`](stable-diffusion/README.md) — long-form notes about the local ROCm build, model layout, workarounds for upstream issues.

---

## 8. (Optional) Add a port / config knob to `config.env.example`

If your tool needs a user-tunable port or secret, append it to [`config.env.example`](../config.env.example) so users discover it. The convention is `UPPER_SNAKE_CASE` for env vars (e.g. `MY_TOOL_PORT`, `MY_TOOL_SECRET_KEY`). Copy the file to `config.env` (un-tracked) on a fresh install.

---

## 9. (Optional) Add the tool to the "Get" catalog in `data/repo.json`

The dashboard's **Get** button on the catalog cards downloads a zip from the URL listed in [`data/repo.json`](../data/repo.json). If the tool you're adding should also appear in that catalog (i.e. the user can install it without it being already present), add an entry under the appropriate `category` (one of: `ai-runtimes`, `ai-chat`, `ai-agents`, `coding`, `automation`, `knowledge`, `image`, `video`, `voice`, `audio`, `documents`, `search`, `3d`, `observability`, `infra`):

```json
{ "id": "my-tool", "name": "My Tool", "url": "https://github.com/example/my-tool/releases/latest/download/my-tool.zip", "category": "ai-runtimes" }
```

The `id` must match the directory slug.

> Note: the `data/repo.json` catalog is independent of the per-tool `tools/<id>/` folders. The dashboard uses the catalog only to fetch a zip; once that zip is unpacked and the per-tool files exist, it switches to managing the tool through those local files. For tools that are always installed from this repo (e.g. you intend users to run `git clone` then `enable.sh`), you do **not** need a `repo.json` entry.

---

## 10. Verify it works

From the repo root:

```bash
./tools/my-tool/enable.sh       # pulls/builds, starts the container
./tools/my-tool/disable.sh      # stops it
```

Then start the dashboard (`./run.sh`) and confirm the card for **My Tool** appears with the right name, icon, and **Open** button pointing at `http://127.0.0.1:<port>`.

If the dashboard does not show the new tool, the usual culprits are:

- `tool.json` is missing or has a JSON syntax error (validate with `python -m json.tool tools/my-tool/tool.json`).
- The folder slug (`my-tool`) does not match the `id` in `data/repo.json` (only matters for the catalog flow).
- The compose service binds to a port already in use — bump the port in `config.env`.

---

## End-to-end checklist

```text
[ ] mkdir tools/my-tool
[ ] tools/my-tool/tool.json          (name, description, kind=docker, url, icon, notes)
[ ] tools/my-tool/compose.yaml       (container_name=local-ai-<id>, ports via ${VAR:-N}, volumes under ../../data/<id>)
[ ] tools/my-tool/enable.sh          (chmod +x; pulls, ups, ps; mkdir -p data/<id>)
[ ] tools/my-tool/disable.sh         (chmod +x; docker compose down)
[ ] tools/my-tool/README.md          (optional, anything tool-specific)
[ ] config.env.example               (optional, add UPPER_SNAKE port/secret defaults)
[ ] data/repo.json                   (optional, catalog entry if it should appear in the "Get" browser)
[ ] ./tools/my-tool/enable.sh        (smoke test from the terminal)
[ ] ./run.sh                         (dashboard renders the new card)
```

That's it — the control plane picks up the new tool with no code changes.
