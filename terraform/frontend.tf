# Frontend v2 (Angular)
resource "kubernetes_deployment" "frontend-v2" {
  metadata {
    name      = "frontend-v2"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    replicas = var.replicas["frontend-v2"]

    selector {
      match_labels = {
        app = "frontend-v2"
      }
    }

    template {
      metadata {
        labels = {
          app = "frontend-v2"
        }
      }

      spec {
        container {
          name  = "frontend-v2"
          image = "${var.registry}/infidraw/frontend-v2:${var.image_tag}"

          port {
            container_port = 80
            name           = "http"
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
      }
    }
  }
}

resource "kubernetes_service" "frontend-v2" {
  metadata {
    name      = "frontend-v2"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    selector = {
      app = "frontend-v2"
    }

    port {
      port        = 80
      target_port = 80
      name        = "http"
    }
  }
}
