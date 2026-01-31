# Diagnose 502 errors: container status, logs, and HTTP probes.
# Run from repo root: .\scripts\diagnose-502.ps1

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
if (Test-Path (Join-Path $root "docker-compose.yml")) {
    Set-Location $root
} else {
    Write-Host "Run from repo root or ensure docker-compose.yml exists." -ForegroundColor Red
    exit 1
}

Write-Host "=== docker compose ps -a ===" -ForegroundColor Cyan
docker compose ps -a

Write-Host "`n=== Nginx error log (last 20 lines) ===" -ForegroundColor Cyan
docker compose logs --tail=20 nginx 2>&1

$services = @("event-store", "tile-service", "realtime-service", "metrics-service", "admin-service", "frontend-v2")
foreach ($s in $services) {
    Write-Host "`n=== $s (last 15 lines) ===" -ForegroundColor Cyan
    docker compose logs --tail=15 $s 2>&1
}

Write-Host "`n=== HTTP probes (localhost:80) ===" -ForegroundColor Cyan
$urls = @(
    @{ Path = "/health"; Name = "nginx health" },
    @{ Path = "/"; Name = "frontend /" }
)
foreach ($u in $urls) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost$($u.Path)" -Method GET -UseBasicParsing -TimeoutSec 5
        Write-Host "  $($u.Name): $($r.StatusCode)" -ForegroundColor Green
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        Write-Host "  $($u.Name): FAIL $code $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host "`nDone. If backends show 'npm install' or no 'running on port', wait or fix startup." -ForegroundColor Gray
