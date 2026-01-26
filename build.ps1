# Build all Docker images
$ErrorActionPreference = "Stop"

Write-Host "Building Docker images..." -ForegroundColor Cyan

# Используем BuildKit для кэширования (DOCKER_BUILDKIT=1)
$env:DOCKER_BUILDKIT = "1"
docker-compose build --progress=plain

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Build completed successfully!" -ForegroundColor Green
