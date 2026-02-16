param(
  [switch]$NoCache,
  [switch]$FrontendOnly,
  [switch]$Verbose,
  [switch]$ChangedOnly,
  [switch]$RecreateBuilder,
  [switch]$Remote,
  [switch]$OneByOne
)

$ErrorActionPreference = "Stop"

# -Remote: kubernetes driver -> N BuildKit pods in devops ns, bake distributes targets across them.
$builderName = "devops-kube"
$kubeNamespace = "devops"
$kubeReplicas = 8
$buildkitdConfig = "buildkitd.toml"

$savedDockerHost = $env:DOCKER_HOST
if ($Remote) { $env:DOCKER_HOST = $null }
else { $env:DOCKER_HOST = $null }

Push-Location $PSScriptRoot
try {
  if ($Remote) {
    if (-not (Test-Path $buildkitdConfig)) { throw "buildkitd.toml not found in $PSScriptRoot" }
    if ($RecreateBuilder) {
      docker buildx rm $builderName 2>$null
      if ($Verbose) { Write-Output "Builder $builderName removed (RecreateBuilder)." }
    }
    docker buildx use $builderName 2>$null
    if ($LASTEXITCODE -ne 0) {
      docker buildx create --name $builderName --driver kubernetes `
        --driver-opt "namespace=$kubeNamespace" `
        --driver-opt "replicas=$kubeReplicas" `
        --buildkitd-config (Resolve-Path $buildkitdConfig).Path `
        --use
      if ($Verbose) { Write-Output "Builder $builderName created (kubernetes driver, $kubeReplicas pods)." }
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
  }
  elseif ($ChangedOnly) {
    $baseRef = "origin/main"
    try { git rev-parse --verify $baseRef 2>$null | Out-Null } catch { $baseRef = "HEAD~1" }
    $changed = @(git diff --name-only $baseRef 2>$null)
    $pathToTarget = @{
      "frontend-v2"               = "frontend-v2"
      "services/event-store"      = "event-store"
      "services/api-gateway"      = "api-gateway"
      "services/realtime-service" = "realtime-service"
      "services/tile-service"     = "tile-service"
      "services/snapshot-worker"  = "snapshot-worker"
      "services/metrics-service"  = "metrics-service"
      "services/admin-service"    = "admin-service"
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

  $prevErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"

  if ($Remote -and $OneByOne) {
    foreach ($t in $deployments) {
      $t0 = Get-Date
      docker buildx bake --builder=$builderName --allow security.insecure -f docker-bake.hcl --provenance=false --push $t 2>&1 | Out-Null
      $dt = (Get-Date) - $t0
      if ($LASTEXITCODE -eq 0) { Write-Output "[$t] ok $([int]$dt.TotalSeconds)s" }
      else { Write-Output "[$t] FAILED"; $ErrorActionPreference = $prevErrorAction; throw "bake $t failed" }
    }
  }
  else {
    $bakeArgs = @(
      "buildx", "bake",
      "--allow", "security.insecure",
      "--file", "docker-bake.hcl",
      "--provenance=false"
    )
    if ($Remote) {
      $bakeArgs += "--builder=$builderName"
      $bakeArgs += "--push"
    } else {
      $bakeArgs += "--load"
      $bakeArgs += "--push"
      # no registry cache export (avoids 404 on cache push), images still push
      $allTargets = @("event-store","api-gateway","realtime-service","tile-service","metrics-service","admin-service","frontend-v2","snapshot-worker")
      foreach ($t in $allTargets) {
        $bakeArgs += "--set"; $bakeArgs += "${t}.cache-to=type=inline"
      }
    }
    if ($NoCache) { $bakeArgs += "--no-cache" }
    if ($targetsToBuild) { $bakeArgs += $targetsToBuild }
    if ($Verbose) { $bakeArgs += "--progress=plain" }
    docker @bakeArgs 2>&1 | Tee-Object -FilePath output-bake.log
    $bakeExitCode = $LASTEXITCODE
    if ($bakeExitCode -ne 0) { $ErrorActionPreference = $prevErrorAction; throw "docker buildx bake exited with $bakeExitCode" }
  }

  $ErrorActionPreference = $prevErrorAction
  $endTime = Get-Date
  $executionTime = $endTime - $startTime
  Write-Output ("Total: {0:hh\:mm\:ss\.fff}" -f [TimeSpan]::FromSeconds($executionTime.TotalSeconds))

  $deployList = $deployments | ForEach-Object { "deployment/$_" }
  kubectl rollout restart -n infidraw $deployList
  # kubectl rollout status -n infidraw $deployList --timeout=120s
}
finally {
  Pop-Location
  $env:DOCKER_HOST = $savedDockerHost
}
