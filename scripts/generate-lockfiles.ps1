# Generate package-lock.json for all services and frontend using Docker
$ErrorActionPreference = "Stop"

$services = @(
    "services/event-store",
    "services/tile-service",
    "services/realtime-service",
    "services/metrics-service",
    "services/admin-service",
    "services/api-gateway",
    "frontend"
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
        if (Test-Path (Join-Path $path "package.json")) {
            # Удаляем старый lock файл если есть
            $lockFile = Join-Path $path "package-lock.json"
            if (Test-Path $lockFile) {
                Remove-Item $lockFile -Force
                Write-Host "  Removed old package-lock.json" -ForegroundColor Gray
            }
            
            # Генерируем новый через Docker
            $serviceName = $service.Replace("/", "-").Replace("\\", "-")
            $containerName = "lockfile-gen-$serviceName"
            
            # Останавливаем и удаляем контейнер если существует
            docker rm -f $containerName 2>$null | Out-Null
            
            # Запускаем временный контейнер для генерации lock файла
            $pathEscaped = $path.Replace('\', '/')
            docker run --rm `
                -v "${pathEscaped}:/app" `
                -w /app `
                node:20-alpine `
                sh -c "npm install --package-lock-only"
            
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  Generated package-lock.json" -ForegroundColor Green
            } else {
                Write-Host "  Error generating package-lock.json" -ForegroundColor Red
            }
        } else {
            Write-Host "  No package.json found, skipping" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  Error: $_" -ForegroundColor Red
    }
}

Write-Host "`nDone!" -ForegroundColor Cyan
