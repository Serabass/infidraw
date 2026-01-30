
param(
  [switch]$NoCache,
  [switch]$FrontendOnly,
  [switch]$Verbose
)

$ErrorActionPreference = "Stop"

# Remote Docker daemon (build on 192.168.88.13)
$savedDockerHost = $env:DOCKER_HOST
$env:DOCKER_HOST = "tcp://192.168.88.13:32375"
$builderName = "infidraw-remote"

try {
  # docker driver does not support cache export (type=registry). Use docker-container driver.
  $existing = docker buildx ls --format "{{.Name}}" 2>$null
  if ($existing -notmatch [regex]::Escape($builderName)) {
    docker buildx create --name $builderName --driver docker-container --use 2>$null
  }
  docker buildx use $builderName 2>$null

  $startTime = Get-Date

  $bakeArgs = @(
    "buildx", "bake",
    "--allow", "security.insecure",
    "--file", "docker-bake.hcl",
    "--load",
    "--push"
  )
  if ($NoCache) { $bakeArgs += "--no-cache" }
  if ($FrontendOnly) { $bakeArgs += "frontend-v2" }
  if ($Verbose) { $bakeArgs += "--progress=plain" }

  docker @bakeArgs #1> bake.log 2>&1

  $endTime = Get-Date
  $executionTime = $endTime - $startTime

  Write-Output ("Elapsed: {0:hh\:mm\:ss\.fff}" -f [TimeSpan]::FromSeconds($executionTime.TotalSeconds))

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
  if ($FrontendOnly) { $deployments = @("frontend-v2") }

  $deployList = $deployments | ForEach-Object { "deployment/$_" }
  kubectl rollout restart -n infidraw $deployList
  kubectl rollout status -n infidraw $deployList --timeout=120s
}
finally {
  $env:DOCKER_HOST = $savedDockerHost
}
