# Запуск проекта

## Требования

- Docker и Docker Compose
- PowerShell (для Windows)

## Запуск

```powershell
docker-compose up --build
```

Или в фоне:

```powershell
docker-compose up -d --build
```

## Сервисы

Все сервисы доступны через **Nginx** на порту 80:

- **Главный вход**: http://localhost (через Nginx)
- **Frontend**: http://localhost (проксируется через Nginx)
- **API**: http://localhost/api/*
  - `/api/strokes` - Event Store
  - `/api/events` - Event Store
  - `/api/tiles` - Tile Service
  - `/api/metrics` - Metrics Service
- **WebSocket**: ws://localhost/ws (Realtime Service)

**Внутренние сервисы** (доступны только внутри Docker сети):
- Event Store: event-store:3000
- Tile Service: tile-service:3000
- Realtime Service: realtime-service:3000 (HTTP), realtime-service:3001 (WebSocket)
- Metrics Service: metrics-service:3000

**Инфраструктура** (для отладки, можно убрать проброс портов):
- **PostgreSQL**: localhost:5432
- **Redis**: localhost:6379
- **MinIO**: http://localhost:9000 (API), http://localhost:9001 (Console)

## Остановка

```powershell
docker-compose down
```

С удалением volumes:

```powershell
docker-compose down -v
```

## Логи

```powershell
docker-compose logs -f [service-name]
```

## Первый запуск

При первом запуске сервисы автоматически создадут необходимые таблицы и бакеты.

MinIO credentials:
- Access Key: `minioadmin`
- Secret Key: `minioadmin`

PostgreSQL credentials:
- Database: `infidraw`
- User: `infidraw`
- Password: `infidraw_dev`

**ВНИМАНИЕ**: Это dev-конфигурация! Для продакшена смените все пароли и используйте секреты.

## Метрики

Сервис метрик отслеживает потребление дискового пространства:

- **GET /api/metrics** - все метрики (PostgreSQL, MinIO, Redis)
- **GET /api/metrics/summary** - краткая сводка с форматированными размерами
- **GET /api/metrics/postgres** - только метрики PostgreSQL
- **GET /api/metrics/minio** - только метрики MinIO
- **GET /api/metrics/redis** - только метрики Redis

Пример ответа `/api/metrics/summary`:
```json
{
  "totalSize": 1048576,
  "totalSizeFormatted": "1 MB",
  "breakdown": {
    "postgres": {
      "size": 524288,
      "sizeFormatted": "512 KB",
      "events": 1234
    },
    "minio": {
      "size": 262144,
      "sizeFormatted": "256 KB",
      "objects": 10
    },
    "redis": {
      "size": 262144,
      "sizeFormatted": "256 KB",
      "clients": 2
    }
  },
  "timestamp": 1737925200000
}
```

## Административные команды

Для управления данными используйте Admin Service (см. [ADMIN.md](./ADMIN.md)):

**Удалить записи старше месяца:**
```powershell
$token = "dev-admin-token-change-in-production"
Invoke-RestMethod -Uri "http://localhost/api/admin/cleanup-old?token=$token" -Method POST
```

**Очистить всё поле:**
```powershell
$token = "dev-admin-token-change-in-production"
Invoke-RestMethod -Uri "http://localhost/api/admin/cleanup-all?token=$token" -Method POST
```

**ВАЖНО**: В продакшене смените токен через переменную окружения `ADMIN_TOKEN`!
