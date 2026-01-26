# Cleanup everything - WARNING: This deletes ALL data!
param(
    [string]$Token = "dev-admin-token-change-in-production",
    [string]$ApiUrl = "http://localhost/api",
    [switch]$Force
)

if (-not $Force) {
    Write-Host "WARNING: This will delete ALL strokes, snapshots, and objects!" -ForegroundColor Red
    Write-Host "This action cannot be undone!" -ForegroundColor Red
    $confirm = Read-Host "Type 'DELETE ALL' to confirm"
    if ($confirm -ne "DELETE ALL") {
        Write-Host "Cancelled." -ForegroundColor Yellow
        exit 0
    }
}

$headers = @{
    "X-Admin-Token" = $Token
    "Content-Type" = "application/json"
}

try {
    $response = Invoke-RestMethod -Uri "$ApiUrl/admin/cleanup-all" -Method POST -Headers $headers
    Write-Host "Success: $($response.message)" -ForegroundColor Green
    Write-Host "Deleted events: $($response.deletedEvents)" -ForegroundColor Cyan
    Write-Host "Deleted snapshots: $($response.deletedSnapshots)" -ForegroundColor Cyan
    Write-Host "Deleted objects: $($response.deletedObjects)" -ForegroundColor Cyan
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
    exit 1
}
