#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
fi

echo "==> Installing host prerequisites"
if command -v pacman >/dev/null 2>&1; then
  sudo pacman -Syu --needed docker docker-compose curl
else
  echo "This setup script currently targets Arch/CachyOS."
  echo "Install Docker Engine, Docker Compose v2, curl, and Python 3 manually."
  exit 1
fi

echo "==> Enabling Docker"
sudo systemctl enable --now docker

if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
  echo "==> Adding $USER to the docker group"
  sudo usermod -aG docker "$USER"
  echo "You may need to log out/in or run: newgrp docker"
fi

echo "==> Creating data directories"
mkdir -p data/{llama-cpp/models,llama-cpp/cache,openwebui,invokeai,comfyui,openhands}

if [[ ! -f config.env ]]; then
  cp config.env.example config.env
fi

chmod +x run.sh server.py tools/*/enable.sh tools/*/disable.sh

echo
echo "Setup complete."
echo "If this shell does not yet have Docker-group access, run: newgrp docker"
echo "Then start the dashboard with: ./run.sh"
