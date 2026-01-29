# Run tests for all backend services (admin, api-gateway, event-store, metrics, realtime, tile)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$services = @('admin-service', 'api-gateway', 'event-store', 'metrics-service', 'realtime-service', 'tile-service')
$failed = @()
foreach ($name in $services) {
  $dir = Join-Path $root "services" $name
  if (-not (Test-Path $dir)) { continue }
  Write-Host "Testing $name..." -ForegroundColor Cyan
  Push-Location $dir
  try {
    npm test 2>&1
    if ($LASTEXITCODE -ne 0) { $failed += $name }
  } finally {
    Pop-Location
  }
}
if ($failed.Count -gt 0) {
  Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "All service tests passed." -ForegroundColor Green
exit 0
