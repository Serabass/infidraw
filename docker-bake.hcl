group "default" {
  targets = [
    "event-store",
    "api-gateway",
    "realtime-service",
    "tile-service",
    "metrics-service",
    "admin-service",
    "frontend",
    "frontend-v2"
  ]
}

variable "REGISTRY" {
  default = "reg.serabass.kz"
}

variable "TAG" {
  default = "latest"
}

target "event-store" {
  context = "./services/event-store"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/event-store:${TAG}"]
  cache-to = ["type=inline"]
  cache-from = ["type=registry,ref=${REGISTRY}/infidraw/event-store:buildcache"]
}

target "api-gateway" {
  context = "./services/api-gateway"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/api-gateway:${TAG}"]
  cache-to = ["type=inline"]
  cache-from = ["type=registry,ref=${REGISTRY}/infidraw/api-gateway:buildcache"]
}

target "realtime-service" {
  context = "./services/realtime-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/realtime-service:${TAG}"]
  cache-to = ["type=inline"]
  cache-from = ["type=registry,ref=${REGISTRY}/infidraw/realtime-service:buildcache"]
}

target "tile-service" {
  context = "./services/tile-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/tile-service:${TAG}"]
  cache-to = ["type=inline"]
  cache-from = ["type=registry,ref=${REGISTRY}/infidraw/tile-service:buildcache"]
}

target "metrics-service" {
  context = "./services/metrics-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/metrics-service:${TAG}"]
  cache-to = ["type=inline"]
  cache-from = ["type=registry,ref=${REGISTRY}/infidraw/metrics-service:buildcache"]
}

target "admin-service" {
  context = "./services/admin-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/admin-service:${TAG}"]
  cache-to = ["type=inline"]
  cache-from = ["type=registry,ref=${REGISTRY}/infidraw/admin-service:buildcache"]
}

target "frontend" {
  context = "./frontend"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/frontend:${TAG}"]
  cache-to = ["type=inline"]
  cache-from = ["type=registry,ref=${REGISTRY}/infidraw/frontend:buildcache"]
}

target "frontend-v2" {
  context = "./frontend-v2"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/frontend-v2:${TAG}"]
  cache-to = ["type=inline"]
  cache-from = ["type=registry,ref=${REGISTRY}/infidraw/frontend-v2:buildcache"]
}
