# Nginx Deployment
resource "kubernetes_deployment" "nginx" {
  metadata {
    name      = "nginx"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    replicas = var.replicas["nginx"]

    selector {
      match_labels = {
        app = "nginx"
      }
    }

    template {
      metadata {
        labels = {
          app = "nginx"
        }
      }

      spec {
        container {
          name  = "nginx"
          image = "nginx:alpine"

          port {
            container_port = 80
            name           = "http"
          }

          volume_mount {
            name       = "nginx-config"
            mount_path = "/etc/nginx/nginx.conf"
            sub_path   = "nginx.conf"
          }

          resources {
            requests = {
              cpu    = "50m"
              memory = "64Mi"
            }
            limits = {
              cpu    = "200m"
              memory = "128Mi"
            }
          }
        }

        volume {
          name = "nginx-config"
          config_map {
            name = kubernetes_config_map.nginx.metadata[0].name
          }
        }
      }
    }
  }
}

resource "kubernetes_service" "nginx" {
  metadata {
    name      = "nginx"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    # Используем ClusterIP, так как доступ через Ingress
    type = var.enable_ingress ? "ClusterIP" : "LoadBalancer"

    selector = {
      app = "nginx"
    }

    port {
      port        = 80
      target_port = 80
      name        = "http"
    }
  }
}

# Ingress для внешнего доступа
resource "kubernetes_ingress_v1" "nginx" {
  count = var.enable_ingress ? 1 : 0

  metadata {
    name      = "nginx-ingress"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
    annotations = {
      # Для Traefik в k3s
      "traefik.ingress.kubernetes.io/router.entrypoints" = "web"
      # Для других ingress controllers можно добавить нужные аннотации
    }
  }

  spec {
    ingress_class_name = var.ingress_class

    rule {
      host = var.ingress_host

      http {
        path {
          path      = "/"
          path_type = "Prefix"

          backend {
            service {
              name = kubernetes_service.nginx.metadata[0].name
              port {
                number = 80
              }
            }
          }
        }
      }
    }
  }
}
