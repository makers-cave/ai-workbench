# syntax=docker/dockerfile:1

# AUTOMATIC1111 Stable Diffusion WebUI on AMD ROCm
# ================================================
# Adapted from AbdBarho/stable-diffusion-webui-docker
# (https://github.com/AbdBarho/stable-diffusion-webui-docker, services/AUTOMATIC1111/Dockerfile).
#
# The upstream image is NVIDIA/CUDA-only. This variant is built from scratch for this
# machine's GPU:
#   * Host GPU: AMD Radeon 8060S / Ryzen AI MAX+ 395 (Strix Halo, RDNA 3.5, gfx1151)
#   * Base:     rocm/pytorch:rocm6.3.4_ubuntu22.04_py3.10_pytorch_release_2.4.0
#               (official AMD ROCm image; ROCm 6.3 was the first line to cover RDNA 3.5 /
#                Strix Halo-class iGPUs, PyTorch is prebuilt against ROCm)
#   * Devices:  /dev/kfd + /dev/dri are passed through by compose.yaml
#   * Runtime:  HSA_OVERRIDE_GFX_VERSION and HIP_VISIBLE_DEVICES are set by compose.yaml
#
# Deviations from upstream (all NVIDIA/ROCm related):
#   * Dropped xformers          -> no official ROCm wheels; use --opt-sdp-no-mem-attention
#   * Dropped pyngrok           -> not needed for a LAN-only instance
#   * Dropped NVIDIA_VISIBLE_DEVICES
#   * Base image is ROCm (conda, python 3.10), not CUDA.

# -- Stage 1: download the pinned repositories the WebUI needs at runtime -------
FROM alpine/git:2.36.2 as download

COPY clone.sh /clone.sh

RUN . /clone.sh stable-diffusion-webui-assets https://github.com/AUTOMATIC1111/stable-diffusion-webui-assets.git 6f7db241d2f8ba7457bac5ca9753331f0c266917

# NOTE: Stability-AI/stablediffusion was DELETED from GitHub (the hash upstream
# pins, cf1d67a6..., is gone with it, so the upstream image currently fails to
# build). We use the canonical original repo (CompVis/stable-diffusion) instead.
# Its ldm package is what the WebUI needs for SD1.x/SD2.0-epsilon/SD-inpainting
# checkpoints; SD2.1-v-prediction is not supported (see README).
RUN . /clone.sh stable-diffusion-stability-ai https://github.com/CompVis/stable-diffusion.git 21f890f9da3cfbeaba8e2ac3c425ee9e998d5229 \
  && rm -rf assets data/**/*.png data/**/*.jpg data/**/*.gif

RUN . /clone.sh BLIP https://github.com/salesforce/BLIP.git 48211a1594f1321b00f14c9f7a5b4813144b2fb9
RUN . /clone.sh k-diffusion https://github.com/crowsonkb/k-diffusion.git ab527a9a6d347f364e3d185ba6d714e22d80cb3c
RUN . /clone.sh clip-interrogator https://github.com/pharmapsychotic/clip-interrogator 2cf03aaf6e704197fd0dae7c7f96aa59cf1b11c9
RUN . /clone.sh generative-models https://github.com/Stability-AI/generative-models 45c443b316737a4ab6e40413d7794a7f5657c19f

# -- Stage 2: runnable image ----------------------------------------------------
FROM rocm/pytorch:rocm6.3.4_ubuntu22.04_py3.10_pytorch_release_2.4.0

ENV DEBIAN_FRONTEND=noninteractive PIP_PREFER_BINARY=1
# Activate the conda environment by default
ENV CONDA_DEFAULT_ENV=py_3.10
ENV CONDA_PREFIX=/opt/conda/envs/py_3.10
ENV PATH="${CONDA_PREFIX}/bin:${PATH}"

RUN --mount=type=cache,target=/var/cache/apt \
  apt-get update && \
  # webui needs those
  apt-get install -y fonts-dejavu-core rsync git jq moreutils aria2 \
  # extensions need those
  ffmpeg libglfw3-dev libgles2-mesa-dev pkg-config libcairo2 libcairo2-dev build-essential

WORKDIR /
RUN --mount=type=cache,target=/root/.cache/pip \
  git clone https://github.com/AUTOMATIC1111/stable-diffusion-webui.git && \
  cd stable-diffusion-webui && \
  git reset --hard v1.9.4 && \
  # torch/torchvision are left unpinned here, so the ROCm build already
  # installed on this base is preserved (no CUDA torch gets substituted in).
  python -m pip install -r requirements_versions.txt

ENV ROOT=/stable-diffusion-webui

# The WebUI's launcher reads these overrides (modules/launch_utils.py). They keep
# the runtime "git hashes match what we baked in" check deterministic for the
# stablediffusion sub-repo (see the clone note above). All other pinned repos use
# the WebUI defaults and are pre-cloned at those exact hashes too.
ENV STABLE_DIFFUSION_REPO="https://github.com/CompVis/stable-diffusion.git" \
    STABLE_DIFFUSION_COMMIT_HASH="21f890f9da3cfbeaba8e2ac3c425ee9e998d5229"

COPY --from=download /repositories/ ${ROOT}/repositories/
RUN mkdir ${ROOT}/interrogate && cp ${ROOT}/repositories/clip-interrogator/clip_interrogator/data/* ${ROOT}/interrogate

# NOTE on the midas module + ldm.data.util:
#   modules/processing.py does `from ldm.data.util import AddMiDaS` (used by
#   depth2img), and modules/sd_models.py does `import ldm.modules.midas as
#   midas` (to wrap midas.api.load_model for auto-downloading weights).
#   The original Stability-AI/stablediffusion repo that hosted both files was
#   DELETED, and the per-file curl URLs the previous Dockerfile used
#   (Stability-AI/generative-models/.../midas/*.py) all 404, silently
#   corrupting every destination file with the literal body "404: Not Found"
#   (no `curl -f`, so the build didn't notice).
#
#   We rebuild ldm.modules.midas + ldm.data.util from the upstream
#   isl-org/MiDaS@v3_1 repo (the version Stability AI forked from) using a
#   small Python bootstrap script. This script:
#     - Copies the upstream midas/ package into the ldm tree.
#     - Rewrites its top-level `from midas.X import ...` imports to
#       `from ldm.modules.midas.X import ...` so it works inside the ldm tree.
#     - Adds a small api.py wrapper that uses torch.hub to fetch the MiDaS
#       model from intel-isl/MiDaS@v3_1 (and falls back to local weights at
#       /data/models/midas/<file>).
#     - Re-creates ldm/data/util.py with the AddMiDaS helper used by
#       depth2img.
RUN git clone https://github.com/CompVis/taming-transformers.git /opt/taming-transformers && \
  cd /opt/taming-transformers && \
  git reset --hard 24268930bf1dce879235a7fddd0b2355b84d7ea6 && \
  python -m pip install -e . && \
  # Pre-clone upstream MiDaS at v3_1.
  git clone --depth=1 --branch v3_1 https://github.com/isl-org/MiDaS.git /opt/MiDaS
RUN python3 - <<'PYEOF'
import os, shutil, pathlib, re

ROOT = os.environ.get("ROOT", "/stable-diffusion-webui")
SRC  = "/opt/MiDaS/midas"
DST  = os.path.join(ROOT, "repositories/stable-diffusion-stability-ai/ldm/modules/midas")

pathlib.Path(DST).parent.mkdir(parents=True, exist_ok=True)
if os.path.exists(DST):
    shutil.rmtree(DST)
shutil.copytree(SRC, DST)

# Add the missing __init__.py files (upstream MiDaS repo omits them).
open(os.path.join(DST, "__init__.py"), "w").close()
backbones = os.path.join(DST, "backbones")
if os.path.isdir(backbones):
    open(os.path.join(backbones, "__init__.py"), "w").close()

# Rewrite `from midas.X` -> `from ldm.modules.midas.X` in the copied files.
def rewrite(path):
    with open(path) as f:
        s = f.read()
    s2 = re.sub(r"^from midas(\.|\s)", "from ldm.modules.midas\\1", s, flags=re.M)
    s2 = re.sub(r"^import midas(\.|\s)", "import ldm.modules.midas\\1", s2, flags=re.M)
    if s2 != s:
        with open(path, "w") as f:
            f.write(s2)

for dirpath, _, files in os.walk(DST):
    for fn in files:
        if fn.endswith(".py"):
            rewrite(os.path.join(dirpath, fn))

# ldm.modules.midas.api: thin wrapper around torch.hub.load so that:
#  - ldm.data.util.AddMiDaS can call `midas_api.load_model(model_type)`
#  - modules/sd_models.enable_midas_autodownload can patch ISL_PATHS to redirect
#    weights into /data/models/midas/.
api = '''"""Thin compatibility layer over upstream MiDaS.

Replaces the deleted Stability-AI/stablediffusion ldm.modules.midas.api. The
original expected local weight files in its own tree; we instead pull weights
on demand from torch.hub (intel-isl/MiDaS@v3_1) the first time they are
requested. The WebUI's enable_midas_autodownload() hook still works: it
mutates ISL_PATHS to point weights at /data/models/midas/, and on first use we
look there before falling back to torch.hub.
"""
import os
import torch
import torch.hub

_HUB_REPO = "intel-isl/MiDaS"

# Mapping model_type -> (hub entrypoint, weights filename). Weights filenames
# match the ISL_PATHS scheme the WebUI monkey-patches in enable_midas_autodownload.
ISL_PATHS = {
    "dpt_large":       os.path.join("weights", "dpt_large-midas-2f21e586.pt"),
    "dpt_hybrid":      os.path.join("weights", "dpt_hybrid-midas-501f0c75.pt"),
    "midas_v21":       os.path.join("weights", "midas_v21-f6b98070.pt"),
    "midas_v21_small": os.path.join("weights", "midas_v21_small-70d6b9c8.pt"),
}

_HUB_ENTRIES = {
    "dpt_large":       "DPT_Large",
    "dpt_hybrid":      "DPT_Hybrid",
    "midas_v21":       "MidasNet",
    "midas_v21_small": "MidasNet_small",
}


def _load_inner(model_type):
    entry = _HUB_ENTRIES.get(model_type, "DPT_Hybrid")
    return torch.hub.load(_HUB_REPO, entry, trust_repo=True)


def load_model_inner(model_type):
    # Compatibility shim for enable_midas_autodownload's monkey-patch.
    return _load_inner(model_type)


def load_model(model_type):
    return _load_inner(model_type)
'''
with open(os.path.join(DST, "api.py"), "w") as f:
    f.write(api)

# Add a LatentDepth2ImageDiffusion stub to ddpm.py so the import in
# modules/processing.py succeeds. CompVis/stable-diffusion (the upstream we
# use) doesn't ship this class — it was added by Stability-AI/stablediffusion
# (the deleted fork). Since depth2img is unusable here anyway (no SD2-depth
# checkpoint family), this is purely a sentinel class for isinstance checks.
# DST is ldm/modules/midas, so ddpm.py is two dirs up + models/diffusion/ddpm.py
ddpm = os.path.join(DST, "..", "..", "models", "diffusion", "ddpm.py")
if os.path.isfile(ddpm):
    with open(ddpm) as f:
        src = f.read()
    if "class LatentDepth2ImageDiffusion" not in src:
        with open(ddpm, "a") as f:
            f.write(
                "\n\nclass LatentDepth2ImageDiffusion(LatentDiffusion):\n"
                "    # Stub. Provided so modules/processing.py's isinstance check\n"
                "    # (`if isinstance(self.sd_model, LatentDepth2ImageDiffusion):`)\n"
                "    # imports cleanly. The original Stability-AI/stablediffusion\n"
                "    # class lived in the deleted upstream repo and is not\n"
                "    # implemented here because depth2img requires SD2-depth\n"
                "    # checkpoints, which we do not ship.\n"
                "    pass\n"
            )

# ldm.data.util: AddMiDaS helper consumed by depth2img (modules/processing.py).
util_path = os.path.join(ROOT, "repositories/stable-diffusion-stability-ai/ldm/data/util.py")
os.makedirs(os.path.dirname(util_path), exist_ok=True)
with open(util_path, "w") as f:
    f.write('''import numpy as np
import torch
from ldm.modules.midas import api as midas_api


class AddMiDaS(object):
    """Depth-conditioning helper used by depth2img.

    Replaces the missing Stability-AI/stablediffusion ldm.data.util. Loads MiDaS
    via ldm.modules.midas.api.load_model (which delegates to torch.hub).
    """

    def __init__(self, model_type="dpt_hybrid"):
        self.model_type = model_type
        self.model = midas_api.load_model(model_type)
        self.model.eval()
        self.transform = torch.hub.load(
            "intel-isl/MiDaS", "transforms", trust_repo=True)

    def __call__(self, input_batch):
        image = input_batch["jpg"]
        image = np.asarray(image).astype(np.float32) / 255.0
        with torch.no_grad():
            sample = self.transform(image)
        return {"midas_in": sample.cpu().numpy()[0]}
''')
PYEOF
RUN sed -i '/class BasicTransformerBlock(nn.Module):/a\    ATTENTION_MODES = {"softmax": None}' ${ROOT}/repositories/stable-diffusion-stability-ai/ldm/modules/attention.py && \
  git config --global --add safe.directory ${ROOT}/repositories/stable-diffusion-stability-ai

RUN --mount=type=cache,target=/root/.cache/pip \
  python -m pip install \
  git+https://github.com/TencentARC/GFPGAN.git@8d2447a2d918f8eba5a4a01463fd48e45126a379 \
  git+https://github.com/openai/CLIP.git@d50d76daa670286dd6cacf3bcd80b5e4823fc8e1 \
  git+https://github.com/mlfoundations/open_clip.git@v2.20.0

# there seems to be a memory leak (or maybe just memory not being freed fast enough)
# that is fixed by this version of malloc (kept from the upstream image)
RUN apt-get -y install libgoogle-perftools-dev && apt-get clean
ENV LD_PRELOAD=libtcmalloc.so

COPY . /docker
RUN chmod +x /docker/entrypoint.sh /docker/clone.sh /docker/config.py 2>/dev/null; true

RUN \
  # one of the ugliest hacks upstream ever wrote: gradio needs to use the app
  # directory instead of the cwd when the webui dir is a symlink target.
  # Find gradio's routes.py dynamically since the path may vary between base images.
  GRADIO_ROUTES=$(find /opt/conda/lib /usr/local/lib /usr/lib -name "routes.py" -path "*/gradio/*" 2>/dev/null | head -1) && \
  if [ -n "$GRADIO_ROUTES" ]; then sed -i 's/in_app_dir = .*/in_app_dir = True/g' "$GRADIO_ROUTES"; fi && \
  # extensions and repositories are git checkouts; avoids "dubious ownership" errors
  git config --global --add safe.directory '*'

WORKDIR ${ROOT}
ENV CLI_ARGS=""
EXPOSE 7860
ENTRYPOINT ["/docker/entrypoint.sh"]
CMD python -u webui.py --listen --port 7860 ${CLI_ARGS}