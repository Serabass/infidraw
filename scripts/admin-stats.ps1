# Get admin statistics
param(
    [string]$Token = "dev-admin-token-change-in-production",
    [string]$ApiUrl = "http://localhost/api"
)

$headers = @{
    "X-Admin-Token" = $Token
}

try {
    $stats = Invoke-RestMethod -Uri "$ApiUrl/admin/stats" -Method GET -Headers $headers
    
    Write-Host "=== Events ===" -ForegroundColor Cyan
    Write-Host "Total: $($stats.events.total)"
    if ($stats.events.oldest) {
        $oldestDate = [DateTimeOffset]::FromUnixTimeMilliseconds($stats.events.oldest).LocalDateTime
        Write-Host "Oldest: $oldestDate"
    }
    if ($stats.events.newest) {
        $newestDate = [DateTimeOffset]::FromUnixTimeMilliseconds($stats.events.newest).LocalDateTime
        Write-Host "Newest: $newestDate"
    }
    
    Write-Host "`n=== Snapshots ===" -ForegroundColor Cyan
    Write-Host "Total in DB: $($stats.snapshots.total)"
    Write-Host "Objects in MinIO: $($stats.snapshots.minioObjects)"
    $sizeMB = [math]::Round($stats.snapshots.minioTotalSize / 1MB, 2)
    Write-Host "Total size: $sizeMB MB"
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
    exit 1
}
