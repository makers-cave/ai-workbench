#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f config.env ]]; then
  set -a
  . ./config.env
  set +a
fi

exec python3 server.py
