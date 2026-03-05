# 3x bake with remote Docker host + registry cache, report times.
# Usage: .\bake-speed-test.ps1
# Requires: DOCKER_HOST already set to remote (bake.ps1 sets it) or run from repo root so bake.ps1 sets it.

$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
  $times = @()
  foreach ($i in 1..3) {
    Write-Host "`n========== BUILD $i/3 ==========" -ForegroundColor Cyan
    $start = Get-Date
    & .\bake.ps1 -WithRegistryCache -Verbose 2>&1 | Tee-Object -FilePath "output-bake-$i.log"
    if ($LASTEXITCODE -ne 0) {
      Write-Host "BUILD $i FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
      exit $LASTEXITCODE
    }
    $elapsed = (Get-Date) - $start
    $sec = [int]$elapsed.TotalSeconds
    $times += $sec
    Write-Host "`nBUILD $i DONE: ${sec}s" -ForegroundColor Green
  }
  Write-Host "`n========== SUMMARY ==========" -ForegroundColor Yellow
  Write-Host "Build 1: $($times[0])s"
  Write-Host "Build 2: $($times[1])s"
  Write-Host "Build 3: $($times[2])s"
  if ($times.Count -ge 2) {
    $speedup = [math]::Round($times[0] / $times[1], 2)
    Write-Host "Speedup (1->2): ${speedup}x" -ForegroundColor Cyan
  }
}
finally {
  Pop-Location
}
