variable "kubeconfig_path" {
  description = "Path to kubeconfig file"
  type        = string
  default     = "~/.kube/config"
}

variable "kubeconfig_context" {
  description = "Kubernetes context to use"
  type        = string
  default     = ""
}

variable "registry" {
  description = "Docker registry for images"
  type        = string
  default     = "reg.serabass.kz"
}

variable "image_tag" {
  description = "Docker image tag"
  type        = string
  default     = "latest"
}

variable "postgres_password" {
  description = "PostgreSQL password"
  type        = string
  default     = "infidraw_dev"
  sensitive   = true
}

variable "minio_root_user" {
  description = "MinIO root user"
  type        = string
  default     = "minioadmin"
}

variable "minio_root_password" {
  description = "MinIO root password"
  type        = string
  default     = "minioadmin"
  sensitive   = true
}

variable "admin_token" {
  description = "Admin service token"
  type        = string
  default     = "dev-admin-token-change-in-production"
  sensitive   = true
}

variable "replicas" {
  description = "Number of replicas for stateless services"
  type        = map(number)
  default = {
    event-store      = 2
    api-gateway      = 2
    realtime-service = 2
    tile-service     = 2
    metrics-service  = 1
    admin-service    = 1
    frontend-v2      = 2
    nginx            = 2
  }
}

variable "enable_ingress" {
  description = "Enable Kubernetes Ingress resource"
  type        = bool
  default     = true
}

variable "ingress_class" {
  description = "Ingress class name (for k3s use 'traefik')"
  type        = string
  default     = "traefik"
}

variable "ingress_host" {
  description = "Ingress hostname"
  type        = string
  default     = "infidraw.serabass.org"
}
