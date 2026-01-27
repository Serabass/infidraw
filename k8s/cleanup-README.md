# Kubernetes CronJob для очистки старых записей

## Описание

CronJob автоматически удаляет записи `stroke_events` старше указанного периода (по умолчанию 7 дней).

## Применение

### Вариант 1: Упрощенный (для dev)

```bash
# Отредактируй k8s/cleanup-cronjob-simple.yaml - укажи свой ADMIN_TOKEN
# Измени CLEANUP_DAYS если нужно (7 = неделя, 30 = месяц)

# Применить CronJob
kubectl apply -f k8s/cleanup-cronjob-simple.yaml

# Проверить статус
kubectl get cronjobs -n infidraw

# Посмотреть последние запуски
kubectl get jobs -n infidraw | grep cleanup-old-strokes

# Посмотреть логи последнего запуска
kubectl logs -n infidraw job/cleanup-old-strokes-<timestamp>
```

### Вариант 2: С секретами (для prod)

```bash
# Создать секрет с токеном (если еще нет)
kubectl create secret generic admin-credentials \
  --from-literal=token=твой-админ-токен \
  -n infidraw

# Применить CronJob
kubectl apply -f k8s/cleanup-cronjob.yaml
```

## Настройка расписания

Измени поле `schedule` в манифесте. Формат: `"минута час день месяц день_недели"`

Примеры:
- `"0 3 * * *"` - каждый день в 3:00 UTC
- `"0 0 * * 0"` - каждое воскресенье в полночь
- `"0 2 1 * *"` - первого числа каждого месяца в 2:00
- `"0 */6 * * *"` - каждые 6 часов

## Настройка периода очистки

Измени переменную окружения `CLEANUP_DAYS`:
- `7` - удалять записи старше недели
- `30` - удалять записи старше месяца
- `90` - удалять записи старше 3 месяцев

## Ручной запуск

Можно запустить Job вручную без ожидания расписания:

```bash
# Создать Job из CronJob
kubectl create job --from=cronjob/cleanup-old-strokes cleanup-manual-$(date +%s) -n infidraw

# Посмотреть логи
kubectl logs -n infidraw job/cleanup-manual-<timestamp>
```

## Удаление CronJob

```bash
kubectl delete cronjob cleanup-old-strokes -n infidraw
```

## Мониторинг

Проверить статистику через admin-service:

```bash
kubectl exec -it -n infidraw <admin-service-pod> -- \
  curl -H "x-admin-token: твой-токен" http://localhost:3000/admin/stats
```
