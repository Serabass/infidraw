# Start all services
$ErrorActionPreference = "Stop"

Write-Host "Stopping services..." -ForegroundColor Cyan

docker-compose down
Write-Host "Building and starting containers (waiting for postgres/redis/minio healthchecks)..." -ForegroundColor Gray
docker-compose up --build -d

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to start services!" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Services started successfully!" -ForegroundColor Green
Write-Host "Use 'docker-compose logs -f' to view logs" -ForegroundColor Gray
