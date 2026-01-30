# Measure response sizes for all GET data routes on InfiDraw API
# Usage: .\scripts\measure-api-responses.ps1 [-BaseUrl 'https://infidraw.serabass.org']
param(
    [string]$BaseUrl = 'https://infidraw.serabass.org',
    [string]$RoomId = '1'
)

$ErrorActionPreference = 'Stop'
$api = $BaseUrl.TrimEnd('/') + '/api'

function Get-ResponseSize {
    param([string]$Method, [string]$Uri, [hashtable]$Query = @{})
    $q = ($Query.GetEnumerator() | ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString($_.Value))" }) -join '&'
    $fullUri = if ($q) { "$Uri`?$q" } else { $Uri }
    try {
        $r = Invoke-WebRequest -Uri $fullUri -Method Get -UseBasicParsing -TimeoutSec 120
        $bodyBytes = [System.Text.Encoding]::UTF8.GetByteCount($r.Content)
        $contentLength = $r.Headers['Content-Length']
        return [pscustomobject]@{
            Status     = $r.StatusCode
            BodyBytes  = $bodyBytes
            HeaderLen  = if ($contentLength) { [long]$contentLength } else { $null }
            Events     = $null
            TilesCount = $null
        }
    } catch {
        return [pscustomobject]@{
            Status     = 'ERROR'
            BodyBytes  = 0
            HeaderLen  = $null
            Error      = $_.Exception.Message
        }
    }
}

function Format-Size($bytes) {
    if ($bytes -ge 1MB) { return "{0:N2} MB" -f ($bytes / 1MB) }
    if ($bytes -ge 1KB) { return "{0:N2} KB" -f ($bytes / 1KB) }
    return "$bytes B"
}

Write-Host "=== InfiDraw API response sizes (base: $api, room: $RoomId) ===" -ForegroundColor Cyan
Write-Host ""

$routes = @(
    @{ Name = 'GET /api/rooms'; Uri = "$api/rooms"; Query = @{} },
    @{ Name = "GET /api/rooms/$RoomId"; Uri = "$api/rooms/$RoomId"; Query = @{} },
    @{ Name = "GET /api/events (room=$RoomId, full)"; Uri = "$api/events"; Query = @{ roomId = $RoomId } },
    @{ Name = "GET /api/events (room=$RoomId, limit=500)"; Uri = "$api/events"; Query = @{ roomId = $RoomId; limit = '500' } },
    @{ Name = "GET /api/events (room=$RoomId, limit=100)"; Uri = "$api/events"; Query = @{ roomId = $RoomId; limit = '100' } },
    @{ Name = "GET /api/tiles (room=$RoomId, view -10..10)"; Uri = "$api/tiles"; Query = @{ roomId = $RoomId; x1 = '-10'; y1 = '-10'; x2 = '10'; y2 = '10' } },
    @{ Name = "GET /api/tiles (room=$RoomId, view -5..5)"; Uri = "$api/tiles"; Query = @{ roomId = $RoomId; x1 = '-5'; y1 = '-5'; x2 = '5'; y2 = '5' } },
    @{ Name = "GET /api/talkers (room=$RoomId)"; Uri = "$api/talkers"; Query = @{ roomId = $RoomId } }
)

$results = @()
foreach ($route in $routes) {
    Write-Host "Request: $($route.Name) ... " -NoNewline
    $res = Get-ResponseSize -Uri $route.Uri -Query $route.Query
    $results += [pscustomobject]@{
        Route = $route.Name
        Status = $res.Status
        BodyBytes = $res.BodyBytes
        SizeFormatted = Format-Size $res.BodyBytes
    }
    if ($res.Status -eq 'ERROR') {
        Write-Host "FAIL: $($res.Error)" -ForegroundColor Red
    } else {
        Write-Host "$($res.Status) | " -NoNewline
        Write-Host (Format-Size $res.BodyBytes) -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "--- Summary ---" -ForegroundColor Cyan
$results | Sort-Object -Property BodyBytes -Descending | Format-Table -AutoSize Route, Status, SizeFormatted, BodyBytes

$total = ($results | Where-Object { $_.BodyBytes -gt 0 } | Measure-Object -Property BodyBytes -Sum).Sum
Write-Host "Total body size (all GET routes above): $(Format-Size $total)" -ForegroundColor Green
Write-Host ""
Write-Host "Note: /api/events without limit returns full event log for room (can be large)." -ForegroundColor Gray
Write-Host "Note: /api/tiles size depends on viewport and tile content (max 100 tiles per request)." -ForegroundColor Gray
