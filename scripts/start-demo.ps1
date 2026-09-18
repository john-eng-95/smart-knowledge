$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker was not found. Install Docker Desktop and run this command again.'
}

docker compose version | Out-Null

if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
  Write-Host 'Created .env from .env.example. Add provider keys if AI features are needed.'
}

docker compose up -d --build

Write-Host ''
Write-Host 'Smart Knowledge demo is starting.'
Write-Host 'Frontend: http://localhost:5173'
Write-Host 'API:      http://localhost:3000'
Write-Host ''
docker compose ps
