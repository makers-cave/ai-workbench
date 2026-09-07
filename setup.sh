#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
fi

echo "==> Installing host prerequisites"
if command -v pacman >/dev/null 2>&1; then
  sudo pacman -Syu --needed docker docker-compose docker-buildx curl
else
  echo "This setup script currently targets Arch/CachyOS."
  echo "Install Docker Engine, Docker Compose v2, docker-buildx, curl, and Python 3 manually."
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
mkdir -p data/{llama-cpp/models,llama-cpp/cache,openwebui,invokeai,comfyui,stable-diffusion,openhands}

if [[ ! -f config.env ]]; then
  cp config.env.example config.env
fi

chmod +x run.sh server.py tools/*/enable.sh tools/*/disable.sh

echo
read -r -p "Install the dashboard as a system startup service? [y/N] " install_service
if [[ "$install_service" =~ ^[Yy]$ ]]; then
  service_dir="$HOME/.config/systemd/user"
  service_path="$service_dir/local-ai-hub.service"

  mkdir -p "$service_dir"
  sed \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$PWD|" \
    -e "s|^ExecStart=.*|ExecStart=$PWD/run.sh|" \
    local-ai-hub.service > "$service_path"

  systemctl --user daemon-reload
  systemctl --user enable --now local-ai-hub.service
  sudo loginctl enable-linger "$USER"
  echo "Dashboard service enabled: $service_path"
fi

echo
echo "Setup complete."
echo "If this shell does not yet have Docker-group access, run: newgrp docker"
echo "Then start the dashboard with: ./run.sh"
