# Build all Docker images using docker buildx bake
$ErrorActionPreference = "Stop"

Write-Host "Building Docker images with docker buildx bake..." -ForegroundColor Cyan

$tag = $args[0]
if (-not $tag) {
    $tag = "latest"
}

Write-Host "Using tag: $tag" -ForegroundColor Yellow
Write-Host "Registry: reg.serabass.kz" -ForegroundColor Yellow

# Build all images with specified tag
# Переопределяем теги для всех targets
$targets = @("event-store", "api-gateway", "realtime-service", "tile-service", "metrics-service", "admin-service", "frontend", "frontend-v2")
$setArgs = @()
foreach ($target in $targets) {
    $setArgs += "--set"
    $setArgs += "$target.tags=reg.serabass.kz/infidraw/$target`:$tag"
}

# Build and push all images
docker buildx bake --push @setArgs

if ($LASTEXITCODE -eq 0) {
    Write-Host "Build completed successfully!" -ForegroundColor Green
} else {
    Write-Host "Build failed!" -ForegroundColor Red
    exit $LASTEXITCODE
}
