# Event Store
resource "kubernetes_deployment" "event-store" {
  metadata {
    name      = "event-store"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    replicas = var.replicas["event-store"]

    selector {
      match_labels = {
        app = "event-store"
      }
    }

    template {
      metadata {
        labels = {
          app = "event-store"
        }
      }

      spec {
        container {
          name  = "event-store"
          image = "${var.registry}/infidraw/event-store:${var.image_tag}"

          env {
            name  = "DATABASE_URL"
            value = "postgresql://infidraw:${var.postgres_password}@postgres:5432/infidraw"
          }

          env {
            name  = "REDIS_URL"
            value = "redis://redis:6379"
          }

          env {
            name  = "PORT"
            value = "3000"
          }

          port {
            container_port = 3000
            name           = "http"
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "128Mi"
            }
            limits = {
              cpu    = "500m"
              memory = "256Mi"
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service" "event-store" {
  metadata {
    name      = "event-store"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    selector = {
      app = "event-store"
    }

    port {
      port        = 3000
      target_port = 3000
      name        = "http"
    }
  }
}

# Tile Service
resource "kubernetes_deployment" "tile-service" {
  metadata {
    name      = "tile-service"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    replicas = var.replicas["tile-service"]

    selector {
      match_labels = {
        app = "tile-service"
      }
    }

    template {
      metadata {
        labels = {
          app = "tile-service"
        }
      }

      spec {
        container {
          name  = "tile-service"
          image = "${var.registry}/infidraw/tile-service:${var.image_tag}"

          env {
            name  = "DATABASE_URL"
            value = "postgresql://infidraw:${var.postgres_password}@postgres:5432/infidraw"
          }

          env {
            name  = "REDIS_URL"
            value = "redis://redis:6379"
          }

          env {
            name  = "MINIO_ENDPOINT"
            value = "minio:9000"
          }

          env {
            name = "MINIO_ACCESS_KEY"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.minio.metadata[0].name
                key  = "MINIO_ROOT_USER"
              }
            }
          }

          env {
            name = "MINIO_SECRET_KEY"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.minio.metadata[0].name
                key  = "MINIO_ROOT_PASSWORD"
              }
            }
          }

          env {
            name  = "MINIO_BUCKET"
            value = "tile-snapshots"
          }

          env {
            name  = "PORT"
            value = "3000"
          }

          env {
            name  = "TILE_SIZE"
            value = "512"
          }

          port {
            container_port = 3000
            name           = "http"
          }

          resources {
            requests = {
              cpu    = "200m"
              memory = "256Mi"
            }
            limits = {
              cpu    = "1000m"
              memory = "512Mi"
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service" "tile-service" {
  metadata {
    name      = "tile-service"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    selector = {
      app = "tile-service"
    }

    port {
      port        = 3000
      target_port = 3000
      name        = "http"
    }
  }
}

# Realtime Service
resource "kubernetes_deployment" "realtime-service" {
  metadata {
    name      = "realtime-service"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    replicas = var.replicas["realtime-service"]

    selector {
      match_labels = {
        app = "realtime-service"
      }
    }

    template {
      metadata {
        labels = {
          app = "realtime-service"
        }
      }

      spec {
        container {
          name  = "realtime-service"
          image = "${var.registry}/infidraw/realtime-service:${var.image_tag}"

          env {
            name  = "DATABASE_URL"
            value = "postgresql://infidraw:${var.postgres_password}@postgres:5432/infidraw"
          }

          env {
            name  = "REDIS_URL"
            value = "redis://redis:6379"
          }

          env {
            name  = "PORT"
            value = "3000"
          }

          env {
            name  = "WS_PORT"
            value = "3001"
          }

          port {
            container_port = 3000
            name           = "http"
          }

          port {
            container_port = 3001
            name           = "ws"
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "128Mi"
            }
            limits = {
              cpu    = "500m"
              memory = "256Mi"
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service" "realtime-service" {
  metadata {
    name      = "realtime-service"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    selector = {
      app = "realtime-service"
    }

    port {
      port        = 3000
      target_port = 3000
      name        = "http"
    }

    port {
      port        = 3001
      target_port = 3001
      name        = "ws"
    }
  }
}

# Metrics Service
resource "kubernetes_deployment" "metrics-service" {
  metadata {
    name      = "metrics-service"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    replicas = var.replicas["metrics-service"]

    selector {
      match_labels = {
        app = "metrics-service"
      }
    }

    template {
      metadata {
        labels = {
          app = "metrics-service"
        }
      }

      spec {
        container {
          name  = "metrics-service"
          image = "${var.registry}/infidraw/metrics-service:${var.image_tag}"

          env {
            name  = "DATABASE_URL"
            value = "postgresql://infidraw:${var.postgres_password}@postgres:5432/infidraw"
          }

          env {
            name  = "REDIS_URL"
            value = "redis://redis:6379"
          }

          env {
            name  = "MINIO_ENDPOINT"
            value = "minio:9000"
          }

          env {
            name = "MINIO_ACCESS_KEY"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.minio.metadata[0].name
                key  = "MINIO_ROOT_USER"
              }
            }
          }

          env {
            name = "MINIO_SECRET_KEY"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.minio.metadata[0].name
                key  = "MINIO_ROOT_PASSWORD"
              }
            }
          }

          env {
            name  = "MINIO_BUCKET"
            value = "tile-snapshots"
          }

          env {
            name  = "PORT"
            value = "3000"
          }

          port {
            container_port = 3000
            name           = "http"
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "128Mi"
            }
            limits = {
              cpu    = "500m"
              memory = "256Mi"
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service" "metrics-service" {
  metadata {
    name      = "metrics-service"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    selector = {
      app = "metrics-service"
    }

    port {
      port        = 3000
      target_port = 3000
      name        = "http"
    }
  }
}

# API Gateway
resource "kubernetes_deployment" "api-gateway" {
  metadata {
    name      = "api-gateway"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    replicas = var.replicas["api-gateway"]

    selector {
      match_labels = {
        app = "api-gateway"
      }
    }

    template {
      metadata {
        labels = {
          app = "api-gateway"
        }
      }

      spec {
        container {
          name  = "api-gateway"
          image = "${var.registry}/infidraw/api-gateway:${var.image_tag}"

          env {
            name  = "REDIS_URL"
            value = "redis://redis:6379"
          }

          env {
            name  = "EVENT_STORE_URL"
            value = "http://event-store:3000"
          }

          env {
            name  = "TILE_SERVICE_URL"
            value = "http://tile-service:3000"
          }

          env {
            name  = "METRICS_SERVICE_URL"
            value = "http://metrics-service:3000"
          }

          env {
            name  = "ADMIN_SERVICE_URL"
            value = "http://admin-service:3000"
          }

          port {
            container_port = 3000
            name           = "http"
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "128Mi"
            }
            limits = {
              cpu    = "500m"
              memory = "256Mi"
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service" "api-gateway" {
  metadata {
    name      = "api-gateway"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    selector = {
      app = "api-gateway"
    }

    port {
      port        = 3000
      target_port = 3000
      name        = "http"
    }
  }
}

# Admin Service
resource "kubernetes_deployment" "admin-service" {
  metadata {
    name      = "admin-service"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    replicas = var.replicas["admin-service"]

    selector {
      match_labels = {
        app = "admin-service"
      }
    }

    template {
      metadata {
        labels = {
          app = "admin-service"
        }
      }

      spec {
        container {
          name  = "admin-service"
          image = "${var.registry}/infidraw/admin-service:${var.image_tag}"

          env {
            name  = "DATABASE_URL"
            value = "postgresql://infidraw:${var.postgres_password}@postgres:5432/infidraw"
          }

          env {
            name  = "REDIS_URL"
            value = "redis://redis:6379"
          }

          env {
            name  = "MINIO_ENDPOINT"
            value = "minio:9000"
          }

          env {
            name = "MINIO_ACCESS_KEY"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.minio.metadata[0].name
                key  = "MINIO_ROOT_USER"
              }
            }
          }

          env {
            name = "MINIO_SECRET_KEY"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.minio.metadata[0].name
                key  = "MINIO_ROOT_PASSWORD"
              }
            }
          }

          env {
            name  = "MINIO_BUCKET"
            value = "tile-snapshots"
          }

          env {
            name  = "PORT"
            value = "3000"
          }

          env {
            name = "ADMIN_TOKEN"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.admin.metadata[0].name
                key  = "ADMIN_TOKEN"
              }
            }
          }

          port {
            container_port = 3000
            name           = "http"
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "128Mi"
            }
            limits = {
              cpu    = "500m"
              memory = "256Mi"
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service" "admin-service" {
  metadata {
    name      = "admin-service"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    selector = {
      app = "admin-service"
    }

    port {
      port        = 3000
      target_port = 3000
      name        = "http"
    }
  }
}
