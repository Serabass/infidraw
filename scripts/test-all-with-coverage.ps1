# Run tests with coverage for all backend services and frontend.
# Usage: .\scripts\test-all-with-coverage.ps1 [ -Docker ]
#   -Docker: run backend tests in node:20-alpine containers (default: local npm)
# Frontend always runs locally (ng test --code-coverage).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $root "services"))) {
  $root = (Get-Location).Path
}
$servicesRoot = (Resolve-Path (Join-Path $root "services")).Path
$frontendRoot = (Resolve-Path (Join-Path $root "frontend-v2")).Path

$useDocker = $args -contains "-Docker"
$nodeImage = "node:20-alpine"

$backendServices = @(
  "admin-service",
  "api-gateway",
  "event-store",
  "metrics-service",
  "realtime-service",
  "tile-service"
)

$results = @{}
$failed = @()

function Get-JestCoverageSummary {
  param([string]$Output)
  foreach ($line in ($Output -split "`n")) {
    if ($line -match "All files\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*[\d.]+") {
      return $line.Trim()
    }
  }
  return $null
}

function Get-KarmaCoverageSummary {
  param([string]$Output)
  # Istanbul text-summary: "Statements : 42.5% ( 17/40 )" or table
  $lines = $Output -split "`n"
  $inSummary = $false
  $summaryParts = @()
  foreach ($line in $lines) {
    if ($line -match "Coverage summary|===========") { $inSummary = $true; continue }
    if ($inSummary -and $line.Trim() -match "^(Statements|Branches|Functions|Lines)\s*[:\|]\s*([\d.]+)\s*\%") {
      $summaryParts += "$($Matches[1])=$($Matches[2])%"
    }
    if ($inSummary -and $line.Trim() -match "^\s*\|\s*All\s*\|") {
      $summaryParts += $line.Trim(); break
    }
  }
  if ($summaryParts.Count -gt 0) { return ($summaryParts -join ", ") }
  foreach ($i in ($lines.Count - 1) .. 0) {
    if ($lines[$i] -match "(\d+\.?\d*)\s*\%") { return $lines[$i].Trim() }
  }
  return "coverage generated (see coverage/infi-draw)"
}

# --- Backend services ---
foreach ($name in $backendServices) {
  $servicePath = Join-Path $servicesRoot $name
  if (-not (Test-Path $servicePath)) {
    Write-Host "Skip $name (not found)" -ForegroundColor Yellow
    continue
  }
  $servicePath = (Resolve-Path $servicePath).Path
  Write-Host ""
  Write-Host "=== $name ===" -ForegroundColor Cyan

  if ($useDocker) {
    $logFile = [System.IO.Path]::GetTempFileName()
    $vol = "`"${servicePath}:/app`""
    $dockerCmd = "docker run --rm -v $vol -w /app -e NODE_ENV=test $nodeImage sh -c `"npm install --silent 2>/dev/null; npm run test:coverage`""
    & cmd /c "$dockerCmd > `"$logFile`" 2>&1"
    $exitCode = $LASTEXITCODE
    $out = Get-Content -Path $logFile -Raw -ErrorAction SilentlyContinue
    Remove-Item -Path $logFile -Force -ErrorAction SilentlyContinue
  } else {
    Push-Location $servicePath
    try {
      $out = & npm run test:coverage 2>&1 | Out-String
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
  }

  if ($out) { $out | Out-Host }
  if ($exitCode -ne 0) {
    $failed += $name
    $results[$name] = @{ Ok = $false; Summary = "FAILED (exit $exitCode)" }
    continue
  }

  $summary = Get-JestCoverageSummary -Output $out
  if (-not $summary) { $summary = "OK (no summary line)" }
  $results[$name] = @{ Ok = $true; Summary = $summary }
}

# --- Frontend ---
Write-Host ""
Write-Host "=== frontend-v2 ===" -ForegroundColor Cyan
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
  Write-Host "Skip frontend-v2 (npm not in PATH)" -ForegroundColor Yellow
  $results["frontend-v2"] = @{ Ok = $true; Summary = "skipped (npm not in PATH)" }
} else {
  Push-Location $frontendRoot
  try {
    $frontOut = & npm run test -- --watch=false --code-coverage 2>&1 | Out-String
    $frontExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($frontOut) { $frontOut | Out-Host }
  if ($frontExit -ne 0) {
    $failed += "frontend-v2"
    $results["frontend-v2"] = @{ Ok = $false; Summary = "FAILED (exit $frontExit)" }
  } else {
    $frontSummary = Get-KarmaCoverageSummary -Output $frontOut
    $results["frontend-v2"] = @{ Ok = $true; Summary = $frontSummary }
  }
}

# --- Summary table ---
Write-Host ""
Write-Host "========== COVERAGE SUMMARY (all + frontend) ==========" -ForegroundColor Green
$allNames = $backendServices + "frontend-v2"
foreach ($name in $allNames) {
  $r = $results[$name]
  if (-not $r) {
    Write-Host ("  {0,-20} : (skipped)" -f $name) -ForegroundColor Gray
    continue
  }
  $color = if ($r.Ok) { "White" } else { "Red" }
  Write-Host ("  {0,-20} : {1}" -f $name, $r.Summary) -ForegroundColor $color
}

if ($failed.Count -gt 0) {
  Write-Host ""
  Write-Host ("Failed: {0}" -f ($failed -join ", ")) -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "All tests passed with coverage." -ForegroundColor Green
exit 0
