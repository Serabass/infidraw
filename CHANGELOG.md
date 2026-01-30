# Changelog

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.0.0/).

---

## [Unreleased]

### Added — Snapshot-worker (Go) и бинарный формат (msgpack)

#### 1) Snapshot-worker (Go)

- Новый сервис **snapshot-worker** на Go: рендер тайла в PNG вынесен из Node в отдельный процесс.
- **Контракт:** `POST /render` — тело JSON: `{ tileX, tileY, tileSize, strokes }`, ответ: `image/png`.
- Рендер через библиотеку **gg** (canvas-like API); ластик рисуется белым по белому фону (тот же визуал, что и раньше).
- **tile-service:** при наличии `SNAPSHOT_WORKER_URL` отправляет запрос в воркер и загружает полученный PNG в MinIO; при отсутствии URL или ошибке воркера — fallback на локальный `createCanvas` (node-canvas).
- В **docker-compose** добавлен сервис `snapshot-worker`, tile-service получает `SNAPSHOT_WORKER_URL: http://snapshot-worker:8080`.

#### 2) Бинарный формат на горячем пути (msgpack)

- **event-store:** публикация в Redis по каналу `stroke_events` переведена на **msgpack** (вместо JSON). POST `/strokes` принимает как JSON, так и **Content-Type: application/msgpack** (тело — msgpack-encoded payload).
- **realtime-service:** подписка на `stroke_events` декодирует сообщения: если пришёл Buffer — msgpack.decode, иначе JSON.parse (обратная совместимость). Клиентам по WS по-прежнему отдаётся JSON.
- Зависимости: в event-store и realtime-service добавлен `@msgpack/msgpack`.

Итого: рендер снапшотов не блокирует event loop Node; Redis между event-store и realtime использует msgpack (меньше CPU и трафика). Фронт и публичный API по-прежнему могут использовать JSON.

---

### Added — Паттерн «тайл → снапшот → дельта» (оптимизация запросов)

Внедрены рекомендации по масштабируемости для «вечного» canvas (Postgres + Redis + MinIO): запросы по тайлам без bbox-мясорубки.

#### 1) Запросы по тайлам, а не по bbox в SQL

- **Было:** `getStrokesForTile` ходил в `stroke_events` с `WHERE min_x/max_x/min_y/max_y` (bbox) — при росте данных это убивает производительность.
- **Стало:**
  - В **event-store** при создании/стирании штриха считаются тайлы по bbox и пишутся строки в **`tile_events`** (одна строка на каждый затронутый тайл).
  - В **tile-service** запрос идёт по **`tile_id`**: сначала читаем из `tile_events` по `room_id` и `tile_id`, собираем штрихи из событий; если по тайлу записей нет (старые данные) — остаётся **fallback на старый bbox-запрос** по `stroke_events`.

#### 2) Один `tile_id` (bigint) и индекс

- Добавлена таблица **`tile_events(room_id, tile_id, id, stroke_id, event_type, payload, ts)`**.
- `tile_id` — один bigint: `(tileX + 500_000) * 1_000_000 + (tileY + 500_000)` (поддержка отрицательных координат).
- Индекс: **`(room_id, tile_id, id)`** — запросы «по тайлу» и «дельта по id» делаются по нему.

#### 3) Один запрос на много тайлов

- В **tile-service** при `GET /tiles` список тайлов по вьюпорту переводится в массив `tile_id`.
- Добавлена **`getTileEventsBatch(roomId, tileIds)`**: один запрос `WHERE room_id = $1 AND tile_id = ANY($2::bigint[])` вместо N запросов по одному тайлу.
- Ответ по тайлам собирается из этой одной выборки (по `tile_id`), без лишних round-trip в БД.

#### 4) Снапшот + дельта

- Логика уже была: `tile_snapshots` + дельта по `sinceVersion`. Теперь дельта по тайлам строится из `tile_events` по `tile_id` (и при необходимости по `id > since_id`), без bbox.

#### 5) Документация и миграция

- В **README** добавлен блок про паттерн «тайл → tile_id → запрос по tile_id IN (...)», про индексы и про то, что bbox в SQL по всем событиям лучше не использовать.
- Скрипт **`scripts/backfill-tile-events.sql`** — разовое заполнение `tile_events` из уже существующих `stroke_events` (только `stroke_created`), без дубликатов. Запуск через Docker/psql по необходимости.

### Not implemented (на потом)

- **JSONB → BYTEA/protobuf** для точек — смена формата на клиенте и в API; оставлен текущий JSONB.
- **Партиционирование** по `tile_id` — когда таблица `tile_events` станет очень большой.
- **Холодное хранение** в MinIO (старые события) — отдельная фаза.
- **Redis** под кэш `tile_state` / hot tiles — сейчас Redis для pub/sub; кэш можно добавить позже.
- **Батчирование вставок** на клиенте (20–50 ms или 50–200 точек) — без смены схемы; можно добавить на уровне API/клиента.
- **pgbouncer** — при большом числе WS-коннектов.

Итого: запросы по тайлам переведены на паттерн **tile_id → один/батч запросов по tile_events**; bbox в SQL убран с «горячего» пути и оставлен только как fallback для старых данных.
