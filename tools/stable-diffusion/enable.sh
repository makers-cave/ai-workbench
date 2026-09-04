#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -f ../../config.env ]]; then
  set -a; . ../../config.env; set +a
fi
mkdir -p ../../data/stable-diffusion
docker compose pull
docker compose up -d
docker compose ps
