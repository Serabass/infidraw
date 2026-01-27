# Clear database - remove all stroke events
$ErrorActionPreference = "Stop"

Write-Host "Clearing database..." -ForegroundColor Cyan

$dbHost = "localhost"
$dbPort = "5432"
$dbName = "infidraw"
$dbUser = "infidraw"
$dbPassword = "infidraw_dev"

$connectionString = "host=$dbHost port=$dbPort dbname=$dbName user=$dbUser password=$dbPassword"

Write-Host "Connecting to database..." -ForegroundColor Yellow

docker-compose exec -T postgres psql -U $dbUser -d $dbName -c "DELETE FROM stroke_events;" 2>&1 | Out-Null

if ($LASTEXITCODE -eq 0) {
    Write-Host "Database cleared successfully!" -ForegroundColor Green
    
    $count = docker-compose exec -T postgres psql -U $dbUser -d $dbName -t -c "SELECT COUNT(*) FROM stroke_events;" 2>&1
    Write-Host "Remaining records: $($count.Trim())" -ForegroundColor Gray
} else {
    Write-Host "Failed to clear database!" -ForegroundColor Red
    exit $LASTEXITCODE
}
