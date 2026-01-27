# Terraform Configuration for InfiDraw on k3s

Terraform конфигурация для развертывания всего стека InfiDraw на Kubernetes (k3s).

## Структура

- `main.tf` - Основная конфигурация (namespace, secrets, configmaps, PVC)
- `variables.tf` - Переменные
- `outputs.tf` - Выводы
- `postgres.tf` - PostgreSQL StatefulSet
- `redis.tf` - Redis Deployment
- `minio.tf` - MinIO Deployment
- `services.tf` - Микросервисы (event-store, tile-service, realtime-service, metrics-service, admin-service)
- `frontend.tf` - Frontend приложения (React и Angular)
- `nginx.tf` - Nginx reverse proxy и Ingress
- `nginx.conf` - Конфигурация Nginx

## Использование

1. Скопируй `terraform.tfvars.example` в `terraform.tfvars`:
   ```powershell
   Copy-Item terraform.tfvars.example terraform.tfvars
   ```

2. Отредактируй `terraform.tfvars` со своими значениями

3. Инициализируй Terraform:
   ```powershell
   terraform init
   ```

4. Проверь план:
   ```powershell
   terraform plan
   ```

5. Примени конфигурацию:
   ```powershell
   terraform apply
   ```

## Volumes

Все PersistentVolumeClaims созданы как заглушки без указания `storage_class_name`. 
Тебе нужно будет:
1. Создать StorageClass в k3s (если еще нет)
2. Обновить PVC в соответствующих файлах, добавив `storage_class_name`

Например, для postgres:
```hcl
spec {
  storage_class_name = "local-path"  # или твой storage class
  access_modes = ["ReadWriteOnce"]
  resources {
    requests = {
      storage = "10Gi"
    }
  }
}
```

## Переменные

Основные переменные:
- `registry` - Docker registry (по умолчанию `reg.serabass.kz`)
- `image_tag` - Тег образов (по умолчанию `latest`)
- `postgres_password` - Пароль PostgreSQL
- `minio_root_user` / `minio_root_password` - Учетные данные MinIO
- `admin_token` - Токен для admin-service
- `replicas` - Количество реплик для каждого сервиса

## Зависимости

Сервисы автоматически ждут готовности зависимостей через health checks:
- Все сервисы ждут PostgreSQL и Redis
- tile-service, metrics-service, admin-service также ждут MinIO

## Ingress

Ingress включен по умолчанию и настроен на домен `infidraw.serabass.org` с использованием Traefik (стандартный ingress controller для k3s).

Чтобы отключить или изменить:
```hcl
enable_ingress = false  # отключить
ingress_class  = "traefik"  # для k3s используется traefik
ingress_host   = "infidraw.serabass.org"  # изменить домен
```

Убедись, что DNS запись для домена указывает на IP твоего k3s кластера.

## Масштабирование

Измени количество реплик в `terraform.tfvars`:
```hcl
replicas = {
  event-store      = 3
  realtime-service = 3
  # ...
}
```

Затем примени изменения:
```powershell
terraform apply
```
