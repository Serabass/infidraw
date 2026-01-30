инфраструктура на Terraform лежит по пути D:\dev\_smarthome\infra3\modules\k3s-apps\infidraw
Можно туда вносить правки, если это необходимо, но выше не смотри.

## Как уменьшить 502 (Bad Gateway)

502 чаще всего — nginx не дотягивается до бэкенда: сервис упал, не успел стартовать или отвалился по таймауту.

**Что уже сделано в репозитории (compose + nginx):**

1. **`restart: unless-stopped`** у всех бэкендов (event-store, tile-service, realtime-service, metrics-service, admin-service, snapshot-worker). При падении контейнера Docker поднимает его снова — кратковременные 502 сами затухают после рестарта.
2. **keepalive** в nginx upstream — переиспользование соединений к бэкендам, меньше обрывов и лишних подключений.
3. **Явные таймауты** в nginx (`proxy_connect_timeout`, `proxy_read_timeout`, `proxy_send_timeout`) — не режем запросы по дефолтному 60s и не висим вечно при «залипшем» бэкенде.

**На проде (K8s/Terraform в infra3):**

- Убедиться, что у подов есть **liveness/readiness** и достаточные **resources** (limit/request), иначе поды будут убиваться или не успевать отвечать.
- При нескольких репликах — в ingress/nginx включить **retry** на 502/503 (например `proxy_next_upstream error timeout http_502 http_503` и таймауты), чтобы запрос ушёл на другой под.
- Логи и метрики: смотреть, какой именно сервис отдаёт 502 (по upstream в логах nginx или по метрикам приложения), и чинить причину (память, БД, редис и т.д.).

**Сделано под 502 на GET /api/events (event-store):**

- В **infidraw** добавлен `GET /health` в event-store и tile-service (для K8s проб).
- В **infra3** (`D:\dev\_smarthome\infra3\modules\k3s-apps\infidraw`):
  - У event-store, tile-service, realtime-service добавлены **readiness_probe** и **liveness_probe** по `/health` — трафик не пойдёт в под до готовности, мёртвый под перезапустится.
  - В **nginx.conf**: keepalive для апстримов, таймауты и **proxy_next_upstream error timeout http_502 http_503** для location event-store — при 2 репликах при 502 запрос уйдёт на другой под.
- После деплоя пересобрать образ event-store (в нём появился /health), применить terraform в infra3, перезапустить поды при необходимости.
