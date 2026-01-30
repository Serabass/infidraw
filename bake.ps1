
param(
  [switch]$NoCache,
  [switch]$FrontendOnly,
  [switch]$Verbose,
  [switch]$ChangedOnly,
  [switch]$RecreateBuilder,
  [switch]$LocalDocker
)

$ErrorActionPreference = "Stop"

# LocalDocker=$true  -> local daemon, no builder, with cache
# LocalDocker=$false -> remote daemon (192.168.88.13), with builder
$savedDockerHost = $env:DOCKER_HOST
if ($LocalDocker) {
  $env:DOCKER_HOST = $null   # local default
} else {
  $env:DOCKER_HOST = "tcp://192.168.88.13:32375"
}

$builderName = "infidraw-remote"

# Run from repo root so buildkitd.toml and docker-bake.hcl paths resolve correctly
Push-Location $PSScriptRoot
try {
  if (-not $LocalDocker) {
    # Remote build: docker driver does not support cache export (type=registry). Use docker-container driver.
    # Registry insecure (reg.serabass.kz) is in buildkitd.toml; passed on builder create.
    if ($RecreateBuilder) {
      try { docker buildx rm $builderName 2>$null } catch { }
      if ($Verbose) { Write-Output "Builder $builderName removed or was missing (RecreateBuilder). Will create with buildkitd.toml." }
    }
    try { docker buildx use $builderName 2>$null } catch { }
    if ($LASTEXITCODE -ne 0) {
      if (-not (Test-Path "buildkitd.toml")) { throw "buildkitd.toml not found in $PSScriptRoot" }
      docker buildx create --name $builderName --driver docker-container --buildkitd-config (Resolve-Path "buildkitd.toml").Path --use
      if ($Verbose) { Write-Output "Builder $builderName created with buildkitd.toml (insecure registry)." }
    }
  }

  $startTime = Get-Date

  $targetsToBuild = $null
  $deployments = @(
    "event-store",
    "api-gateway",
    "realtime-service",
    "tile-service",
    "metrics-service",
    "admin-service",
    "frontend-v2",
    "snapshot-worker"
  )

  if ($FrontendOnly) {
    $targetsToBuild = @("frontend-v2")
    $deployments = @("frontend-v2")
  } elseif ($ChangedOnly) {
    $baseRef = "origin/main"
    try { git rev-parse --verify $baseRef 2>$null | Out-Null } catch { $baseRef = "HEAD~1" }
    $changed = @(git diff --name-only $baseRef 2>$null)
    $pathToTarget = @{
      "frontend-v2" = "frontend-v2"
      "services/event-store" = "event-store"
      "services/api-gateway" = "api-gateway"
      "services/realtime-service" = "realtime-service"
      "services/tile-service" = "tile-service"
      "services/snapshot-worker" = "snapshot-worker"
      "services/metrics-service" = "metrics-service"
      "services/admin-service" = "admin-service"
    }
    $targetsToBuild = @()
    foreach ($p in $changed) {
      foreach ($path in $pathToTarget.Keys) {
        if ($p -like "$path*") { $targetsToBuild += $pathToTarget[$path]; break }
      }
    }
    $targetsToBuild = $targetsToBuild | Sort-Object -Unique
    if ($targetsToBuild.Count -eq 0) {
      Write-Output "ChangedOnly: no service/frontend changes (vs $baseRef), nothing to build."
      exit 0
    }
    $deployments = $targetsToBuild
    if ($Verbose) { Write-Output "ChangedOnly: building $($targetsToBuild -join ', ')" }
  }

  $bakeArgs = @(
    "buildx", "bake",
    "--allow", "security.insecure",
    "--file", "docker-bake.hcl",
    "--load",
    "--push"
  )
  if ($NoCache) { $bakeArgs += "--no-cache" }
  if ($targetsToBuild) { $bakeArgs += $targetsToBuild }
  if ($Verbose) { $bakeArgs += "--progress=plain" }

  docker @bakeArgs #1> bake.log 2>&1

  $endTime = Get-Date
  $executionTime = $endTime - $startTime

  Write-Output ("Elapsed: {0:hh\:mm\:ss\.fff}" -f [TimeSpan]::FromSeconds($executionTime.TotalSeconds))

  $deployList = $deployments | ForEach-Object { "deployment/$_" }
  kubectl rollout restart -n infidraw $deployList
  # kubectl rollout status -n infidraw $deployList --timeout=120s
}
finally {
  Pop-Location
  $env:DOCKER_HOST = $savedDockerHost
}
