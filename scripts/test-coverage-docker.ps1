# Run tests with coverage for each microservice via Docker.
# Uses node:20-alpine + volume mount so no project image build needed (avoids npm ci lockfile issues).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $root "services"))) {
    $root = (Get-Location).Path
}
$servicesRoot = (Resolve-Path (Join-Path $root "services")).Path

# Only services that have tests (api-gateway has tests but is not in docker-compose)
$services = @(
    "admin-service",
    "api-gateway",
    "event-store",
    "metrics-service",
    "realtime-service",
    "tile-service"
)

$results = @{}
$failed = @()
$nodeImage = "node:20-alpine"

foreach ($name in $services) {
    $servicePath = Join-Path $servicesRoot $name
    if (-not (Test-Path $servicePath)) {
        Write-Host "Skip $name (path not found: $servicePath)" -ForegroundColor Yellow
        continue
    }
    $servicePath = (Resolve-Path $servicePath).Path
    Write-Host ""
    Write-Host "=== $name ===" -ForegroundColor Cyan
    $prevErrAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = docker run --rm `
        -v "${servicePath}:/app" `
        -w /app `
        -e NODE_ENV=test `
        $nodeImage `
        sh -c "npm install --silent 2>/dev/null; npm run test:coverage" 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevErrAction
    $out | Out-Host

    if ($exitCode -ne 0) {
        $failed += $name
        $results[$name] = @{ Ok = $false; Summary = "FAILED (exit $exitCode)" }
        continue
    }

    # Parse Jest coverage summary line "All files | xx | xx | xx | xx"
    $summary = "OK"
    foreach ($line in ($out -split "`n")) {
        if ($line -match "All files\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*[\d.]+") {
            $summary = $line.Trim()
            break
        }
    }
    $results[$name] = @{ Ok = $true; Summary = $summary }
}

Write-Host ""
Write-Host "========== COVERAGE SUMMARY ==========" -ForegroundColor Green
foreach ($name in $services) {
    $r = $results[$name]
    if (-not $r) { Write-Host ("  {0,-20} : (skipped)" -f $name) -ForegroundColor Gray; continue }
    $color = if ($r.Ok) { "White" } else { "Red" }
    Write-Host ("  {0,-20} : {1}" -f $name, $r.Summary) -ForegroundColor $color
}

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "Failed services: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
exit 0
