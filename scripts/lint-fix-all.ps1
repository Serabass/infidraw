# Run eslint --fix for all Node/TS services via docker-compose. Minimal output.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$services = @('event-store', 'tile-service', 'realtime-service', 'metrics-service', 'admin-service')
$r = $root
Push-Location $root

$failed = @()
foreach ($name in $services) {
  $out = docker-compose run --rm --no-deps -v "${r}:/workspace" -w /workspace $name sh -c "npm install --prefix /workspace --silent 2>/dev/null; cd services/$name; npm install --silent 2>/dev/null; npm run lint:fix -- --quiet" 2>&1
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    Write-Host "$name : OK" -ForegroundColor Green
  } else {
    $failed += $name
    $errLine = ($out | Select-String -Pattern "(\d+) (problems|errors?)" | Select-Object -Last 1)
    if ($errLine) { Write-Host "$name : FAIL ($errLine)" -ForegroundColor Red } else { Write-Host "$name : FAIL (exit $code)" -ForegroundColor Red }
  }
}

Pop-Location
if ($failed.Count -gt 0) {
  Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "Lint fix done." -ForegroundColor Green
exit 0
