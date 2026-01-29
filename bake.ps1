$startTime = Get-Date

# --host "tcp://192.168.88.13:32375" `

docker `
  buildx bake `
  --allow security.insecure `
  --file docker-bake.hcl `
  --load `
  --push 1> bake.log 2>&1

$endTime = Get-Date
$executionTime = $endTime - $startTime

Write-Output ("Elapsed: {0:hh\:mm\:ss\.fff}" -f [TimeSpan]::FromSeconds($executionTime.TotalSeconds))

kubectl rollout restart -n infidraw deployment/event-store
kubectl rollout restart -n infidraw deployment/api-gateway
kubectl rollout restart -n infidraw deployment/realtime-service
kubectl rollout restart -n infidraw deployment/tile-service
kubectl rollout restart -n infidraw deployment/metrics-service
kubectl rollout restart -n infidraw deployment/admin-service
kubectl rollout restart -n infidraw deployment/frontend-v2
