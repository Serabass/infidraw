output "namespace" {
  description = "Kubernetes namespace"
  value       = kubernetes_namespace.infidraw.metadata[0].name
}

output "nginx_service" {
  description = "Nginx service name"
  value       = kubernetes_service.nginx.metadata[0].name
}

output "postgres_service" {
  description = "PostgreSQL service name"
  value       = kubernetes_service.postgres.metadata[0].name
}

output "redis_service" {
  description = "Redis service name"
  value       = kubernetes_service.redis.metadata[0].name
}

output "minio_service" {
  description = "MinIO service name"
  value       = kubernetes_service.minio.metadata[0].name
}
