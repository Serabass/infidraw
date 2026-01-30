# Дорожная карта: производительность и стек

Рекомендации сопоставлены с текущим кодом infidraw. Узкие места — не «язык», а Postgres, JSON на горячем пути, рендер снапшотов в event loop и тонны мелких WS-сообщений.

---

## Текущее состояние (что уже есть в коде)

| Рекомендация | Где у нас | Файлы |
|--------------|-----------|--------|
| WS сервер | `ws` (не uWebSockets) | `realtime-service`: `ws`, `JSON.stringify(event)` |
| HTTP | Express везде | Все сервисы: `express` |
| Сериализация | **Redis: msgpack** (event-store → Redis → realtime), API: JSON или msgpack | event-store публикует msgpack, realtime декодирует; POST /strokes принимает `application/msgpack` |
| Снапшоты тайлов | **Вынесены в snapshot-worker (Go)** при `SNAPSHOT_WORKER_URL` | `tile-service`: при наличии URL вызывает `POST /render`, иначе локальный `renderTileSnapshot()` |
| Batch insert | Поштучно/не батчами | event-store: вставки в `stroke_events` / `tile_events` |

---

## Приоритет 1: быстрые победы (остаёмся на Node)

### 1.1 Убрать JSON с горячего пути (strokes)

- **Где:** event-store (приём/отдача stroke), realtime (Redis + WS).
- **Что:** protobuf или msgpack для stroke; точки в int (×100), payload как `Buffer`.
- **Типы:** `shared/types/stroke.ts` — `Stroke`, `points: Array<[number, number]>`; фронт и бэк договориться о бинарном формате.

Эффект: меньше CPU на parse/stringify, меньше трафика и диска.

### 1.2 uWebSockets.js вместо `ws`

- **Где:** `realtime-service/src/index.ts` — сейчас `WebSocketServer` из `ws`, рассылка `ws.send(JSON.stringify(event))`.
- **Что:** заменить на `uWebSockets.js` (тот же контракт `/ws`, можно сначала оставить JSON, потом подмешать бинарный формат).

Эффект: кратный прирост по коннектам/сообщениям при той же логике.

### 1.3 Fastify вместо Express (на горячих сервисах)

- **Где:** event-store, tile-service, realtime (HTTP часть) — там, где много запросов/сериализации.
- **Что:** поэтапно: один сервис (например event-store или tile-service), потом остальные.

Эффект: меньше накладных расходов, нормальные схемы/валидация.

### 1.4 GET /events: кэш и диагностика

- **Где:** `event-store` — GET `/events?roomId=&since=0` (полная выдача событий комнаты).
- **Что уже сделано:** тайминг в логах (`db=...ms total=...ms`), Redis-кэш для `since=0` (TTL 10 сек, инвалидация при записи в комнату). Повторные запросы и вторая вкладка получают ответ из кэша.
- **Если всё ещё медленно:** проверить план запроса в Postgres: `EXPLAIN (ANALYZE, BUFFERS) SELECT event_type, stroke_id, stroke_data, timestamp FROM stroke_events WHERE room_id = $1 AND timestamp > $2 ORDER BY timestamp ASC LIMIT $3` — должен использоваться индекс `idx_stroke_events_room_timestamp`. Большой `stroke_data` (много точек) увеличивает время чтения с диска.

### 1.5 Postgres: батчи, prepared statements, backpressure

- **Где:** event-store — вставки в `stroke_events` и `tile_events`.
- **Что:** пачки `INSERT ... VALUES (...),(...),...`, prepared statements, пул; при росте очереди записи — backpressure (буфер или дроп/замедление).

Эффект: меньше нагрузки на БД и предсказуемая латентность.

---

## Приоритет 2: вынести тяжёлую работу из Node

### 2.1 Snapshot worker (Rust или Go) — **сделано (Go)**

Рендер тайла вынесен в отдельный сервис **snapshot-worker** (Go, библиотека gg). Tile-service при `SNAPSHOT_WORKER_URL` вызывает `POST /render` и получает PNG; иначе используется локальный Node canvas (fallback).

Раньше рендер выполнялся **в том же процессе**, что и HTTP:

- **Файл:** `services/tile-service/src/index.ts`
- **Функция:** `renderTileSnapshot(tileX, tileY, strokes)` — `createCanvas`, 2d контекст, цикл по strokes, `canvas.toBuffer('image/png')`.
- **Вызов:** из GET `/tiles` при отсутствии готового снапшота — рендер, затем загрузка в MinIO.

**Варианты:**

- **A) Worker в процессе Node:** вынести только `renderTileSnapshot` в `worker_threads`, очередь задач, результат — Buffer в MinIO. Меньше изменений, но Node всё ещё держит на себе нагрузку по рендеру.
- **B) Отдельный сервис (рекомендуется):** отдельный **snapshot-worker** на **Rust** (или Go): принимает запрос «тайл (x,y) + список strokes», возвращает PNG (или кладёт в MinIO сам). Tile-service тогда только: читает данные из БД, если нет снапшота — вызывает worker, получает URL/буфер, отдаёт клиенту.

**Почему Rust/Go здесь:** рендер и кодирование PNG — CPU-bound; Node при этом «смотрит в стену». Rust даёт максимум пропускной способности и минимум памяти; Go — быстрее написать и ввести в строй.

---

## Приоритет 3: гибридный стек (если захочется «пошустрее» язык)

- **Realtime (WS + ingest):** при росте нагрузки — переписать на **Go** (или Elixir): много соединений, I/O, немного CPU.
- **Tile delta API:** если tile-service на Node начнёт захлёбываться на чтении/агрегации — вынести чтение тайлов/дельт в отдельный сервис на **Go**.
- **Snapshot worker:** см. выше — **Rust** или **Go** в первую очередь.

Node оставить как оркестратор: api-gateway, авторизация, простые CRUD, фронт.

---

## Что делать по шагам (минимум боли, максимум эффекта)

1. **Оставить Node** как контроллер/оркестратор.
2. **Перевести strokes на бинарный формат** (protobuf/msgpack) — выигрыш сразу по CPU и трафику.
3. **Заменить `ws` на uWebSockets.js** в realtime-service (контракт `/ws` сохранить).
4. **Вынести снапшоты в отдельный воркер-сервис** на Rust или Go; tile-service только запрашивает рендер и отдаёт URL/данные.
5. При необходимости **tile delta API** вынести в Go позже.
6. По желанию — **Fastify** и **батчи + backpressure** в event-store.

---

## Краткий вывод

Node норм, пока его не нагружают тяжёлой работой «на одной ноге». Самый выгодный апгрейд: **бинарный протокол + uWebSockets + вынести снапшоты**. Если хочется быстрее язык: **Go для realtime/ingest**, **Rust для снапшотов**.

Документ можно обновлять по мере внедрения шагов (например, отмечать «uWebSockets внедрён», «snapshot-worker на Go в проде»).
