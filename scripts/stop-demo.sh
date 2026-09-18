#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null 2>&1 || {
  echo "Docker was not found. Install Docker and run this command again." >&2
  exit 1
}

docker compose down
echo "Smart Knowledge demo stopped. Data volumes were kept."
