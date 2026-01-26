# Build all Docker images
$ErrorActionPreference = "Stop"

Write-Host "Building Docker images..." -ForegroundColor Cyan

docker-compose build --progress=plain

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Build completed successfully!" -ForegroundColor Green
