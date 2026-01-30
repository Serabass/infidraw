# Measure response sizes for all GET data routes on InfiDraw API
# Usage: .\scripts\measure-api-responses.ps1 [-BaseUrl 'https://infidraw.serabass.org']
param(
    [string]$BaseUrl = 'https://infidraw.serabass.org',
    [string]$RoomId = '1'
)

$ErrorActionPreference = 'Stop'
$api = $BaseUrl.TrimEnd('/') + '/api'

function Get-ResponseSize {
    param([string]$Uri, [hashtable]$Query = @{}, [hashtable]$Headers = @{})
    $q = ($Query.GetEnumerator() | ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString($_.Value))" }) -join '&'
    $fullUri = if ($q) { "$Uri`?$q" } else { $Uri }
    try {
        $params = @{ Uri = $fullUri; Method = 'Get'; UseBasicParsing = $true; TimeoutSec = 120 }
        if ($Headers.Count -gt 0) { $params['Headers'] = $Headers }
        $r = Invoke-WebRequest @params
        $bodyBytes = if ($Headers['Accept'] -eq 'application/msgpack') {
            $ms = [System.IO.MemoryStream]::new()
            $r.RawContentStream.CopyTo($ms)
            [long]$ms.Length
        } else {
            [System.Text.Encoding]::UTF8.GetByteCount($r.Content)
        }
        return [pscustomobject]@{ Status = $r.StatusCode; BodyBytes = $bodyBytes; Error = $null }
    } catch {
        return [pscustomobject]@{ Status = 'ERROR'; BodyBytes = 0; Error = $_.Exception.Message }
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
    @{ Name = 'GET /api/rooms'; Uri = "$api/rooms"; Query = @{}; Headers = @{} },
    @{ Name = "GET /api/rooms/$RoomId"; Uri = "$api/rooms/$RoomId"; Query = @{}; Headers = @{} },
    @{ Name = "GET /api/events (room=$RoomId, full)"; Uri = "$api/events"; Query = @{ roomId = $RoomId }; Headers = @{} },
    @{ Name = "GET /api/events (room=$RoomId, limit=500) JSON"; Uri = "$api/events"; Query = @{ roomId = $RoomId; limit = '500' }; Headers = @{} },
    @{ Name = "GET /api/events (room=$RoomId, limit=500) msgpack"; Uri = "$api/events"; Query = @{ roomId = $RoomId; limit = '500' }; Headers = @{ Accept = 'application/msgpack' } },
    @{ Name = "GET /api/tiles (room=$RoomId, view -10..10)"; Uri = "$api/tiles"; Query = @{ roomId = $RoomId; x1 = '-10'; y1 = '-10'; x2 = '10'; y2 = '10' }; Headers = @{} },
    @{ Name = "GET /api/tiles (room=$RoomId, view -5..5)"; Uri = "$api/tiles"; Query = @{ roomId = $RoomId; x1 = '-5'; y1 = '-5'; x2 = '5'; y2 = '5' }; Headers = @{} },
    @{ Name = "GET /api/talkers (room=$RoomId)"; Uri = "$api/talkers"; Query = @{ roomId = $RoomId }; Headers = @{} }
)

$results = @()
foreach ($route in $routes) {
    Write-Host "Request: $($route.Name) ... " -NoNewline
    $res = Get-ResponseSize -Uri $route.Uri -Query $route.Query -Headers $route.Headers
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
Write-Host "Chunk (limit=500): JSON vs msgpack - compare rows above." -ForegroundColor Gray
Write-Host "Note: /api/events without limit returns full event log (can be large)." -ForegroundColor Gray
