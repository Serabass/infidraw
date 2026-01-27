# Generate package-lock.json for all services and frontend using Docker
$ErrorActionPreference = "Stop"

$services = @(
    "services/event-store",
    "services/tile-service",
    "services/realtime-service",
    "services/metrics-service",
    "services/admin-service",
    "services/api-gateway",
    "frontend-v2"
)

Write-Host "Generating package-lock.json files using Docker..." -ForegroundColor Cyan

$rootDir = Split-Path $PSScriptRoot -Parent

foreach ($service in $services) {
    $path = Join-Path $rootDir $service
    if (-not (Test-Path $path)) {
        Write-Host "Skipping $service - directory not found" -ForegroundColor Yellow
        continue
    }
    
    Write-Host "Processing $service..." -ForegroundColor Green
    
    try {
        $packageJson = Join-Path $path "package.json"
        if (-not (Test-Path $packageJson)) {
            Write-Host "  No package.json found, skipping" -ForegroundColor Yellow
            continue
        }
        
        # Удаляем старый lock файл если есть
        $lockFile = Join-Path $path "package-lock.json"
        if (Test-Path $lockFile) {
            Remove-Item $lockFile -Force
            Write-Host "  Removed old package-lock.json" -ForegroundColor Gray
        }
        
        # Генерируем новый через Docker
        # Используем абсолютный путь для Windows
        $absolutePath = (Resolve-Path $path).Path
        
        Write-Host "  Running npm install in Docker..." -ForegroundColor Gray
        docker run --rm `
            -v "${absolutePath}:/app" `
            -w /app `
            node:20-alpine `
            sh -c "npm install --package-lock-only"
        
        if ($LASTEXITCODE -eq 0 -and (Test-Path $lockFile)) {
            Write-Host "  Generated package-lock.json" -ForegroundColor Green
        }
        else {
            Write-Host "  Error generating package-lock.json (exit code: $LASTEXITCODE)" -ForegroundColor Red
        }
    }
    catch {
        Write-Host "  Error: $_" -ForegroundColor Red
    }
}

Write-Host "`nDone!" -ForegroundColor Cyan
