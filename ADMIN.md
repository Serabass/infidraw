# Административные команды

> Дорожная карта по производительности и стеку (бинарный протокол, uWebSockets, snapshot-worker на Rust/Go): [docs/PERF-ROADMAP.md](docs/PERF-ROADMAP.md)

## Требования

- Docker и Docker Compose
- PowerShell (для Windows)
- Токен администратора (по умолчанию: `dev-admin-token-change-in-production`)

## Команды

### Через скрипты (рекомендуется)

```powershell
# Удалить записи старше месяца
.\scripts\cleanup-old.ps1

# Очистить всё поле (потребует подтверждения)
.\scripts\cleanup-all.ps1

# Получить статистику
.\scripts\admin-stats.ps1
```

### Через API напрямую

#### Удалить записи старше одного месяца

```powershell
# Через API
$token = "dev-admin-token-change-in-production"
Invoke-RestMethod -Uri "http://localhost/api/admin/cleanup-old?token=$token" -Method POST

# Или через заголовок
$headers = @{ "X-Admin-Token" = $token }
Invoke-RestMethod -Uri "http://localhost/api/admin/cleanup-old" -Method POST -Headers $headers
```

#### Очистить всё поле (удалить все strokes)

**ВНИМАНИЕ**: Эта команда удаляет ВСЁ безвозвратно!

```powershell
$token = "dev-admin-token-change-in-production"
Invoke-RestMethod -Uri "http://localhost/api/admin/cleanup-all?token=$token" -Method POST
```

#### Получить статистику

```powershell
$token = "dev-admin-token-change-in-production"
Invoke-RestMethod -Uri "http://localhost/api/admin/stats?token=$token" -Method GET
```

## Примеры ответов

### cleanup-old
```json
{
  "success": true,
  "deletedEvents": 1234,
  "cutoffTimestamp": 1735320000000,
  "message": "Deleted 1234 events older than one month"
}
```

### cleanup-all
```json
{
  "success": true,
  "deletedEvents": 5678,
  "deletedSnapshots": 123,
  "deletedObjects": 123,
  "message": "Cleaned up everything: 5678 events, 123 snapshots, 123 objects"
}
```

### stats
```json
{
  "events": {
    "total": 5678,
    "oldest": 1735320000000,
    "newest": 1737925200000
  },
  "snapshots": {
    "total": 123,
    "minioObjects": 123,
    "minioTotalSize": 10485760
  }
}
```

## Безопасность

**ВАЖНО**: В продакшене обязательно:
1. Смените `ADMIN_TOKEN` на сложный случайный токен
2. Используйте HTTPS
3. Ограничьте доступ к admin-эндпоинтам по IP
4. Добавьте логирование всех админ-операций

Токен можно задать через переменную окружения `ADMIN_TOKEN` в docker-compose.yml.
