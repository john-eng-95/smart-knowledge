#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null 2>&1 || {
  echo "Docker was not found. Install Docker and run this command again." >&2
  exit 1
}

docker compose version >/dev/null

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Add provider keys if AI features are needed."
fi

docker compose up -d --build

echo
echo "Smart Knowledge demo is starting."
echo "Frontend: http://localhost:5173"
echo "API:      http://localhost:3000"
echo
docker compose ps
