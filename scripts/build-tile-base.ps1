# Build base image for tile-service with build tools
# This needs to be built only once, then it will be reused
$ErrorActionPreference = "Stop"

$serviceDir = Join-Path (Split-Path $PSScriptRoot -Parent) "services\tile-service"
$dockerfile = Join-Path $serviceDir "Dockerfile.base"

Write-Host "Building tile-service base image (this may take a while on first run)..." -ForegroundColor Cyan
Write-Host "This image will be cached and reused for faster builds" -ForegroundColor Gray

$env:DOCKER_BUILDKIT = "1"
docker build -f $dockerfile -t tile-service-base:latest $serviceDir

if ($LASTEXITCODE -ne 0) {
  Write-Host "Failed to build base image!" -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host "Base image built successfully!" -ForegroundColor Green
Write-Host "Now you can build tile-service faster using: .\build.ps1" -ForegroundColor Gray
