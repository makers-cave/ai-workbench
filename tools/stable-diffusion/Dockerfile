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
  pip install -r requirements_versions.txt

ENV ROOT=/stable-diffusion-webui

# The WebUI's launcher reads these overrides (modules/launch_utils.py). They keep
# the runtime "git hashes match what we baked in" check deterministic for the
# stablediffusion sub-repo (see the clone note above). All other pinned repos use
# the WebUI defaults and are pre-cloned at those exact hashes too.
ENV STABLE_DIFFUSION_REPO="https://github.com/CompVis/stable-diffusion.git" \
    STABLE_DIFFUSION_COMMIT_HASH="21f890f9da3cfbeaba8e2ac3c425ee9e998d5229"

COPY --from=download /repositories/ ${ROOT}/repositories/
RUN mkdir ${ROOT}/interrogate && cp ${ROOT}/repositories/clip-interrogator/clip_interrogator/data/* ${ROOT}/interrogate

RUN --mount=type=cache,target=/root/.cache/pip \
  pip install \
  git+https://github.com/TencentARC/GFPGAN.git@8d2447a2d918f8eba5a4a01463fd48e45126a379 \
  git+https://github.com/openai/CLIP.git@d50d76daa670286dd6cacf3bcd80b5e4823fc8e1 \
  git+https://github.com/mlfoundations/open_clip.git@v2.20.0

# there seems to be a memory leak (or maybe just memory not being freed fast enough)
# that is fixed by this version of malloc (kept from the upstream image)
RUN apt-get -y install libgoogle-perftools-dev && apt-get clean
ENV LD_PRELOAD=libtcmalloc.so

COPY . /docker

RUN \
  # one of the ugliest hacks upstream ever wrote: gradio needs to use the app
  # directory instead of the cwd when the webui dir is a symlink target.
  sed -i 's/in_app_dir = .*/in_app_dir = True/g' /opt/conda/lib/python3.10/site-packages/gradio/routes.py && \
  # extensions and repositories are git checkouts; avoids "dubious ownership" errors
  git config --global --add safe.directory '*'

WORKDIR ${ROOT}
ENV CLI_ARGS=""
EXPOSE 7860
ENTRYPOINT ["/docker/entrypoint.sh"]
CMD python -u webui.py --listen --port 7860 ${CLI_ARGS}