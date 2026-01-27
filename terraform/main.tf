terraform {
  required_version = ">= 1.0"
  
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.23"
    }
  }
}

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kubeconfig_context
}

# Namespace
resource "kubernetes_namespace" "infidraw" {
  metadata {
    name = "infidraw"
  }
}

# ConfigMap для nginx
resource "kubernetes_config_map" "nginx" {
  metadata {
    name      = "nginx-config"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  data = {
    "nginx.conf" = file("${path.module}/nginx.conf")
  }
}

# Secrets
resource "kubernetes_secret" "postgres" {
  metadata {
    name      = "postgres-secret"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  data = {
    POSTGRES_DB       = base64encode("infidraw")
    POSTGRES_USER     = base64encode("infidraw")
    POSTGRES_PASSWORD = base64encode(var.postgres_password)
  }
}

resource "kubernetes_secret" "minio" {
  metadata {
    name      = "minio-secret"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  data = {
    MINIO_ROOT_USER     = base64encode(var.minio_root_user)
    MINIO_ROOT_PASSWORD = base64encode(var.minio_root_password)
  }
}

resource "kubernetes_secret" "admin" {
  metadata {
    name      = "admin-secret"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  data = {
    ADMIN_TOKEN = base64encode(var.admin_token)
  }
}

# Persistent Volume Claims (заглушки)
resource "kubernetes_persistent_volume_claim" "postgres" {
  metadata {
    name      = "postgres-data"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    access_modes = ["ReadWriteOnce"]
    resources {
      requests = {
        storage = "10Gi"
      }
    }
    # Заглушка - storage_class_name не указан, будет использован default
  }
}

resource "kubernetes_persistent_volume_claim" "redis" {
  metadata {
    name      = "redis-data"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    access_modes = ["ReadWriteOnce"]
    resources {
      requests = {
        storage = "5Gi"
      }
    }
  }
}

resource "kubernetes_persistent_volume_claim" "minio" {
  metadata {
    name      = "minio-data"
    namespace = kubernetes_namespace.infidraw.metadata[0].name
  }

  spec {
    access_modes = ["ReadWriteOnce"]
    resources {
      requests = {
        storage = "50Gi"
      }
    }
  }
}
