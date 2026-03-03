# Run tests for all Rust services under services/.rust/ (one container per service).
# Usage: .\scripts\test-rust-services.ps1
# Exit 1 if any service tests fail (do not run docker bake after).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$rustDir = Join-Path (Join-Path $root "services") ".rust"
if (-not (Test-Path $rustDir)) {
  Write-Host "services/.rust not found, nothing to test." -ForegroundColor Yellow
  exit 0
}
$rustRoot = (Resolve-Path $rustDir).Path
$rustImage = "rust:1.83-bookworm"
$failed = @()
$results = @{}

$dirs = Get-ChildItem -Path $rustRoot -Directory | Sort-Object Name
$prevErrorAction = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  foreach ($dir in $dirs) {
    $name = $dir.Name
    $servicePath = $dir.FullName
    Write-Host ""
    Write-Host "=== $name ===" -ForegroundColor Cyan
    $out = docker run --rm -v "${servicePath}:/app" -w /app $rustImage cargo test 2>&1
    $exitCode = $LASTEXITCODE
    if ($out) { $out | Out-Host }
    if ($exitCode -ne 0) {
      $failed += $name
      $results[$name] = "FAILED (exit $exitCode)"
    } else {
      $results[$name] = "OK"
    }
  }
} finally {
  $ErrorActionPreference = $prevErrorAction
}

Write-Host ""
Write-Host "========== RUST TESTS SUMMARY ==========" -ForegroundColor Green
foreach ($name in ($dirs | Sort-Object Name | ForEach-Object { $_.Name })) {
  $r = $results[$name]
  $color = if ($r -eq "OK") { "White" } else { "Red" }
  Write-Host ("  {0,-25} : {1}" -f $name, $r) -ForegroundColor $color
}

if ($failed.Count -gt 0) {
  Write-Host ""
  Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "All Rust service tests passed." -ForegroundColor Green
exit 0
