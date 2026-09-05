# Stable Diffusion (AUTOMATIC1111 WebUI, AMD ROCm edition)

Docker Compose + Dockerfile for running
[AUTOMATIC1111/stable-diffusion-webui](https://github.com/AUTOMATIC1111/stable-diffusion-webui)
on this machine's **AMD GPU (Radeon 8060S / Ryzen AI MAX+ 395, Strix Halo gfx1151)**.

Adapted from [AbdBarho/stable-diffusion-webui-docker](https://github.com/AbdBarho/stable-diffusion-webui-docker).
That repo is **NVIDIA-only** (CUDA base images, `driver: nvidia`), so this variant builds the
same `AUTOMATIC1111` service from scratch on top of an **official AMD ROCm PyTorch** image.

## Stack

| Piece | Choice |
|---|---|
| Base image | `rocm/pytorch:rocm6.3.4_ubuntu22.04_py3.10_pytorch_release_2.4.0` (PyTorch prebuilt for ROCm) |
| WebUI | AUTOMATIC1111 `v1.9.4` + its pinned sub-repositories |
| Device access | `/dev/kfd` + `/dev/dri` passthrough, `group_add: [video, render]`, `ipc: host`, `seccomp: unconfined` |
| Runtime env | `HSA_OVERRIDE_GFX_VERSION` (default `11.5.1` = gfx1151), `HIP_VISIBLE_DEVICES=0`, from `config.env` |
| Attention | `--opt-sdp-no-mem-attention` (xformers has no ROCm wheels) |
| SD sub-repo | `CompVis/stable-diffusion` (see "Deleted upstream repo" below) |

## Enable

```bash
./tools/stable-diffusion/enable.sh      # builds the image, then starts the service
```

First build pulls the ~23 GB ROCm base image and installs the WebUI: expect **20-60 minutes**.
Subsequent starts take seconds. The dashboard now runs the build in the background and shows
progress — you can click Enable from the dashboard and watch the build progress in the log sidebar.
You can also run `enable.sh` directly from a terminal if you prefer.

Open http://127.0.0.1:7860 after the container is `running`.

## Models

The UI needs a checkpoint to generate anything. Two options:

1. **Seed the SD1.5 set (same files upstream ships)** — ~5 GB:

   ```bash
   cd tools/stable-diffusion
   docker compose --profile download up --build
   ```

   This drops `v1-5-pruned-emaonly.ckpt`, inpainting, VAE and upscalers into
   `data/stable-diffusion/models/`.

2. **Drop your own .safetensors/.ckpt** into
   `data/stable-diffusion/models/Stable-diffusion/` and restart:
   `docker compose -f tools/stable-diffusion/compose.yaml restart`.

## Where things live (inside the container)

`entrypoint.sh` symlinks the WebUI's mutable folders onto `/data` (host: `data/stable-diffusion/`),
so model downloads, embeddings, extensions and settings survive container restarts.

| Container path | Host path |
|---|---|
| `/data/models` | `data/stable-diffusion/models` |
| `/data/embeddings` | `data/stable-diffusion/embeddings` |
| `/data/config/auto` | `data/stable-diffusion/config/auto` |
| `/output` | `data/stable-diffusion/output` |

## Tuning

`CLI_ARGS` in `compose.yaml` controls the WebUI. Current default:

```text
--allow-code --medvram --opt-sdp-no-mem-attention --enable-insecure-extension-access --api --skip-torch-cuda-test --skip-load-model-at-start
```

Common tweaks for this APU:

- `--medvram` → drop it if you want maximum quality at 512x512 (the iGPU shares system RAM).
- `--no-half-vae` + `--no-half` → add only if you see black/NaN outputs on a specific model.
- Remove `--skip-torch-cuda-test` once you've confirmed the WebUI reports the GPU.
- `--skip-load-model-at-start` is set so the gradio UI comes up even when
  the background model-load thread crashes. **On this APU today** (ROCm
  6.3.4 + PyTorch 2.4 + gfx1151), `torch.tensor.to("cuda")` segfaults
  inside `apply_alpha_schedule_override()` as soon as the model is moved
  onto the iGPU. Removing `--skip-load-model-at-start` causes the WebUI
  process to die right after the gradio server starts, so the URL
  returns "empty page". Leave it on until the ROCm runtime / PyTorch
  combo for Strix Halo is fixed; once model loading works, drop it.

### Doesn't work with ROCm

- `--xformers` — no official ROCm wheels; SDP attention covers it.
- `--opt-sub-quad-attention` / `--lowvram` are CUDA-specific in places; prefer `--medvram` + SDP.

## Deleted upstream repo (important)

Upstream `AbdBarho/stable-diffusion-webui-docker` pins `Stability-AI/stablediffusion`
(the "ldm" package the WebUI imports), but **Stability AI deleted that GitHub
repository**. As a result the upstream Dockerfile — and any fresh AUTOMATIC1111
install using its default URL — currently **fails to build** with
`remote: Repository not found`.

This compose file works around it in three places:

1. `Dockerfile` (build stage) clones the canonical, still-alive original
   **`CompVis/stable-diffusion`** at commit `21f890f...` into the path the WebUI
   imports (`repositories/stable-diffusion-stability-ai`). Note that repo is SD1.x
   era: **SD1.5, SD1.5-inpainting, SD2.0 and SDXL checkpoint families work**;
   SD2.1 **v-prediction** checkpoints are not supported (rarely used, deprecated).
2. `ENV STABLE_DIFFUSION_REPO` / `STABLE_DIFFUSION_COMMIT_HASH` — these are the
   official overrides the WebUI's `launch_utils.py` reads, keeping its startup
   git-hash check consistent with what was baked into the image.
3. **Rebuilding `ldm.modules.midas` from upstream `isl-org/MiDaS@v3_1`.**
   CompVis/stable-diffusion doesn't ship the `ldm.modules.midas.*` files the
   WebUI imports (those lived in the deleted Stability-AI repo). The previous
   Dockerfile tried to fetch them per-file with `curl -sL` from
   `Stability-AI/generative-models/.../midas/*.py` — but **all of those URLs
   404 today**, and `curl -sL` wrote the literal body `404: Not Found` into
   every destination file without raising. The build appeared to succeed but
   `webui.py` then crashed with `ModuleNotFoundError: No module named 'ldm.data.util'`
   (or `'ldm.modules.midas'`) at startup. We now:
   - `git clone --depth=1 --branch v3_1 https://github.com/isl-org/MiDaS.git`
     (the version Stability AI originally forked from),
   - copy `midas/` into the ldm tree, rewrite its top-level `from midas.X`
     imports to `from ldm.modules.midas.X`, and add the missing
     `__init__.py` files,
   - ship a small `ldm.modules.midas.api` wrapper that exposes the
     `ISL_PATHS` / `load_model(model_type)` interface the WebUI's
     `enable_midas_autodownload()` hook monkey-patches, delegating to
     `torch.hub.load("intel-isl/MiDaS", ...)` for weights,
   - ship `ldm/data/util.py` with the `AddMiDaS` helper used by depth2img.
4. **Stub class `LatentDepth2ImageDiffusion` in `ldm/models/diffusion/ddpm.py`.**
   `modules/processing.py` does
   `from ldm.models.diffusion.ddpm import LatentDepth2ImageDiffusion` for a
   single `isinstance()` check that gates depth2img. CompVis/stable-diffusion
   doesn't ship that class. We append an empty `class LatentDepth2ImageDiffusion(LatentDiffusion): pass`
   so the import succeeds. **depth2img itself is not functional** (it requires
   the SD2-depth checkpoint family, which we don't ship), but txt2img, img2img,
   inpainting, and the rest of the WebUI work normally.

Also note: upstream `clone.sh` strips `.git` from each cloned repo. We keep it —
without it, `git rev-parse HEAD` inside a repo directory resolves to the parent
WebUI repository, the hash never matches, and the WebUI would try to fetch/checkout
against the (dead) origin URL at startup.

## Notes

- Version pins (WebUI `v1.9.4`, sub-repositories, GFPGAN, CLIP, open_clip) are the exact ones
  upstream tests with; only the base image, NVIDIA-only extras, and the deleted SD
  sub-repo mirror were changed.
- Upstream `clone.sh`/`config.py`/`entrypoint.sh` are used, with the `.git` retention
  explained above.
- If Docker Hub rate-limits the base pull, run `docker login` first, then retry the build.
- GPU check: `docker compose -f tools/stable-diffusion/compose.yaml logs stable-diffusion | grep -i -E "device|rocm|hip|gpu"`.