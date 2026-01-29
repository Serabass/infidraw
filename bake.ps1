$startTime = Get-Date

# --host "tcp://192.168.88.13:32375" `

docker `
  buildx bake `
  --allow security.insecure `
  --file docker-bake.hcl `
  --load `
  --push 

$endTime = Get-Date
$executionTime = $endTime - $startTime

Write-Output ("Elapsed: {0:hh\:mm\:ss\.fff}" -f [TimeSpan]::FromSeconds($executionTime.TotalSeconds))
