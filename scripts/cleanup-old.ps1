# Cleanup old records (older than specified days, default 30 days = one month)
param(
    [string]$Token = "dev-admin-token-change-in-production",
    [string]$ApiUrl = "http://localhost/api",
    [int]$Days = 30
)

$headers = @{
    "X-Admin-Token" = $Token
    "Content-Type" = "application/json"
}

$body = @{
    days = $Days
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$ApiUrl/admin/cleanup-old" -Method POST -Headers $headers -Body $body
    Write-Host "Success: $($response.message)" -ForegroundColor Green
    Write-Host "Deleted events: $($response.deletedEvents)" -ForegroundColor Cyan
    Write-Host "Cutoff date: $($response.cutoffDate)" -ForegroundColor Gray
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
    exit 1
}
