#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -f ../../config.env ]]; then
  set -a; . ../../config.env; set +a
fi
mkdir -p ../../data/stable-diffusion/output
# Image is built from the local Dockerfile (ROCm). First build pulls the ~23GB
# ROCm base and installs the WebUI, which takes 20-60 minutes.
# If you run this from the dashboard (180s timeout), the build may appear to
# time out; run this script from a terminal instead and it will finish.
docker compose build stable-diffusion
docker compose up -d
docker compose ps
