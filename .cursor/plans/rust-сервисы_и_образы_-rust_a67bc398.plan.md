---
name: Rust-сервисы и образы -rust
overview: Список всех бэкенд-сервисов для переписывания на Rust, образы с суффиксом -rust, покрытие тестами и запуск тестов в Docker.
todos: []
isProject: false
---

# Переписывание сервисов на Rust и образы с суффиксом -rust

## Сервисы, которые стоит переписать на Rust

Все перечисленные сервисы сейчас на **Node.js/TypeScript** (см. [docker-bake.hcl](docker-bake.hcl) и Dockerfile’ы в `services/`). Frontend (Angular) не трогаем.


| №   | Сервис               | Язык (сейчас)   | Назначение (по коду/конфигам)                                            |
| --- | -------------------- | --------------- | ------------------------------------------------------------------------ |
| 1   | **event-store**      | TypeScript/Node | API событий/стриков, комнаты, talkers; Postgres + Redis; порт 3000       |
| 2   | **api-gateway**      | TypeScript/Node | Шлюз/оркестратор (в bake и k8s; в docker-compose не задействован)        |
| 3   | **realtime-service** | TypeScript/Node | Реалтайм (WebSocket); Postgres + Redis; порты 3000, 3001                 |
| 4   | **tile-service**     | TypeScript/Node | Тайлы/снапшоты; Postgres, Redis, MinIO, вызов snapshot-worker; порт 3000 |
| 5   | **snapshot-worker**  | TypeScript/Node | Статусный рендер (без БД); порт 8080                                     |
| 6   | **metrics-service**  | TypeScript/Node | Метрики; Postgres, Redis, MinIO; порт 3000                               |
| 7   | **admin-service**    | TypeScript/Node | Админка; Postgres, Redis, MinIO, ADMIN_TOKEN; порт 3000                  |


**Итого: 7 бэкенд-сервисов** — все они переписываются на Rust; образы для них должны собираться с суффиксом `-rust`.

---

## Куда добавлять образы с суффиксом -rust

- **[docker-bake.hcl](docker-bake.hcl)**  
  - В `group "default"` добавить таргеты: `event-store-rust`, `api-gateway-rust`, `realtime-service-rust`, `tile-service-rust`, `snapshot-worker-rust`, `metrics-service-rust`, `admin-service-rust`.  
  - Для каждого таргета описать `target "<service>-rust"`: `context` — каталог с Rust-проектом `**./services/.rust/<service>`** (например `./services/.rust/event-store`), `dockerfile` — Dockerfile для Rust (в этом каталоге), `tags = ["${REGISTRY}/infidraw/<service>-rust:${TAG}"]`, при необходимости те же `cache-from`/`cache-to`, что и у остальных образов.
- **[bake.ps1](bake.ps1)**  
  - В списки `$deployments` и при `$allTargets` (и в `$pathToTarget` для `ChangedOnly`) добавить те же семь имён с суффиксом `-rust`; для `ChangedOnly` маппинг пути: `services/.rust/event-store` → `event-store-rust`, и т.д., чтобы скрипт мог собирать и перезапускать Rust-деплойменты в k8s.
- **Структура Rust-проектов:** переписанные сервисы хранятся в `**./services/.rust/`** — один подкаталог на сервис, без суффикса `-rust` в пути:
  - `./services/.rust/event-store/` (Cargo-проект + Dockerfile)
  - `./services/.rust/api-gateway/`
  - `./services/.rust/realtime-service/`
  - … и т.д. для всех семи сервисов.  
  Образы по-прежнему с суффиксом `-rust` (например `infidraw/event-store-rust:${TAG}`).

---

## Итоговый список сервисов для переписывания

1. **event-store** → образ `event-store-rust`
2. **api-gateway** → образ `api-gateway-rust`
3. **realtime-service** → образ `realtime-service-rust`
4. **tile-service** → образ `tile-service-rust`
5. **snapshot-worker** → образ `snapshot-worker-rust`
6. **metrics-service** → образ `metrics-service-rust`
7. **admin-service** → образ `admin-service-rust`

После реализации Rust-версий в docker-compose/nginx/k8s можно будет переключать сервисы на образы с суффиксом `-rust` (и при желании со временем убрать старые Node-образы из дефолтного билда).

---

## Покрытие тестами и запуск тестов в Docker

**Порядок выполнения:** тесты прогоняются **по одной сборке (одному сервису) за раз** — каждая сборка в отдельном шаге/контейнере; после того как **все** тесты прошли успешно, в конце выполняется **docker bake** (сборка образов).

### Порядок шагов (общий скрипт или CI)

1. **По одному сервису:** для каждой сборки (Node-сервис или Rust-сервис) — отдельный прогон: поднять контейнер с исходниками, выполнить тесты (и при необходимости сбор покрытия), завершить контейнер. Не объединять несколько сервисов в один `docker run`.
2. **В конце:** если все тесты зелёные — выполнить `docker buildx bake -f docker-bake.hcl …` (или вызов [bake.ps1](bake.ps1) с нужными параметрами). Если хотя бы один сервис упал — bake не запускать, exit code 1.

### Rust-сервисы

- **Покрытие:** в каждом Rust-проекте под `**./services/.rust/<service>/`** (например `./services/.rust/event-store/`): unit-тесты (`#[test]`), при необходимости интеграционные (`tests/`); сбор покрытия — **cargo-tarpaulin** (или **cargo-llvm-cov**).
- **Запуск в Docker:** для **каждого** сервиса в `services/.rust/` отдельно: образ с Rust-тулчейном, монтировать каталог этого сервиса (например `./services/.rust/event-store`), в контейнере `cargo test` (и при флаге — `cargo tarpaulin …`). Один контейнер = один сервис.
- **Скрипт:** например `scripts/test-rust-services.ps1` — цикл по подкаталогам `**./services/.rust/*`** (event-store, api-gateway, …), на каждой итерации один `docker run -v "<path>:/app" … cargo test`; сводка в конце; при падении — exit 1 и дальше bake не вызывать.

### Node-сервисы

- Уже есть: [scripts/test-all-services.ps1](scripts/test-all-services.ps1) (-Docker), [scripts/test-coverage-docker.ps1](scripts/test-coverage-docker.ps1), [scripts/test-all-with-coverage.ps1](scripts/test-all-with-coverage.ps1). Каждый сервис тестируется отдельно (свой контейнер/прогон). При объединении в один «полный» пайплайн: сначала все Node-тесты по одному сервису, затем все Rust-тесты по одному сервису, затем **docker bake**.

