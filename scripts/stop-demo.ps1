$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker was not found. Install Docker Desktop and run this command again.'
}

docker compose down
Write-Host 'Smart Knowledge demo stopped. Data volumes were kept.'
