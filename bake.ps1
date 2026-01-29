$startTime = Get-Date

# --host "tcp://192.168.88.13:32375" `

docker `
  --host "tcp://192.168.88.13:32375" `
  buildx bake `
  --allow security.insecure `
  --file docker-bake.hcl `
  --load `
  --push 1> bake.log 2>&1

$endTime = Get-Date
$executionTime = $endTime - $startTime

Write-Output ("Elapsed: {0:hh\:mm\:ss\.fff}" -f [TimeSpan]::FromSeconds($executionTime.TotalSeconds))

$deployments = @(
  "event-store", "api-gateway", "realtime-service", "tile-service",
  "metrics-service", "admin-service", "frontend-v2"
)

$deployList = $deployments | ForEach-Object { "deployment/$_" }
kubectl rollout restart -n infidraw $deployList
kubectl rollout status -n infidraw $deployList --timeout=120s
