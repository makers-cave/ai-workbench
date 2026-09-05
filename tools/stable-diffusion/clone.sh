#!/bin/bash

set -Eeuox pipefail

mkdir -p /repositories/"$1"
cd /repositories/"$1"
git init
git remote add origin "$2"
git fetch origin "$3" --depth=1
git reset --hard "$3"
# Keep .git on purpose! The WebUI checks `git rev-parse HEAD` at startup
# (git_clone in modules/launch_utils.py). Without .git, git resolves to the
# parent WebUI repository, the hash never matches, and the WebUI would try to
# fetch/checkout from the configured origin URL (which for the SD repo would be
# a dead URL) -- crashing startup.