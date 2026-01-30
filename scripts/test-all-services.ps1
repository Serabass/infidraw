# Run tests for all backend services (admin, api-gateway, event-store, metrics, realtime, tile)
# Usage: .\test-all-services.ps1 [ -Docker ]  (default: npm test locally; -Docker: run in node:20-alpine)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$useDocker = $args -contains '-Docker'
$services = @('admin-service', 'api-gateway', 'event-store', 'metrics-service', 'realtime-service', 'tile-service')
$failed = @()
$nodeImage = 'node:20-alpine'

foreach ($name in $services) {
  $dir = Join-Path (Join-Path $root "services") $name
  if (-not (Test-Path $dir)) { continue }
  Write-Host "Testing $name..." -ForegroundColor Cyan
  if ($useDocker) {
    $servicePath = (Resolve-Path $dir).Path
    $out = docker run --rm -v "${servicePath}:/app" -w /app -e NODE_ENV=test $nodeImage sh -c "npm ci --silent 2>/dev/null; npm test 2>&1" 2>&1
    if ($LASTEXITCODE -ne 0) {
      $failed += $name
      $lines = ($out -split "`n"); $tail = if ($lines.Count -gt 20) { $lines[-20..-1] -join "`n" } else { $out }
      Write-Host $tail -ForegroundColor Red
    } else {
      $match = [regex]::Match($out, 'Tests:\s+(\d+)\s+passed')
      if ($match.Success) { Write-Host "  $($match.Groups[1].Value) passed" -ForegroundColor Gray } else { Write-Host "  OK" -ForegroundColor Gray }
    }
  } else {
    Push-Location $dir
    try {
      npm test 2>&1
      if ($LASTEXITCODE -ne 0) { $failed += $name }
    } finally {
      Pop-Location
    }
  }
}
if ($failed.Count -gt 0) {
  Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "All service tests passed." -ForegroundColor Green
exit 0
