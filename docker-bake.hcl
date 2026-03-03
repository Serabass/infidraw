group "default" {
  targets = [
    "event-store",
    "api-gateway",
    "realtime-service",
    "tile-service",
    "snapshot-worker",
    "metrics-service",
    "admin-service",
    "event-store-rust",
    "api-gateway-rust",
    "realtime-service-rust",
    "tile-service-rust",
    "snapshot-worker-rust",
    "metrics-service-rust",
    "admin-service-rust",
    "frontend-v2"
  ]
}

variable "REGISTRY" {
  default = "reg.home.local"
}

variable "TAG" {
  default = "latest"
}

variable "USE_REGISTRY_CACHE" {
  default = "1"
}

target "event-store" {
  context = "./services/event-store"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/event-store:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/event-store:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/event-store:buildcache", "type=registry,ref=${REGISTRY}/infidraw/event-store:latest"] : []
}

target "api-gateway" {
  context = "./services/api-gateway"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/api-gateway:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/api-gateway:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/api-gateway:buildcache", "type=registry,ref=${REGISTRY}/infidraw/api-gateway:latest"] : []
}

target "realtime-service" {
  context = "./services/realtime-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/realtime-service:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/realtime-service:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/realtime-service:buildcache", "type=registry,ref=${REGISTRY}/infidraw/realtime-service:latest"] : []
}

target "tile-service" {
  context = "./services/tile-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/tile-service:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/tile-service:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/tile-service:buildcache", "type=registry,ref=${REGISTRY}/infidraw/tile-service:latest"] : []
}

target "snapshot-worker" {
  context = "./services/snapshot-worker"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/snapshot-worker:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/snapshot-worker:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/snapshot-worker:buildcache", "type=registry,ref=${REGISTRY}/infidraw/snapshot-worker:latest"] : []
}

target "metrics-service" {
  context = "./services/metrics-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/metrics-service:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/metrics-service:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/metrics-service:buildcache", "type=registry,ref=${REGISTRY}/infidraw/metrics-service:latest"] : []
}

target "admin-service" {
  context = "./services/admin-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/admin-service:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/admin-service:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/admin-service:buildcache", "type=registry,ref=${REGISTRY}/infidraw/admin-service:latest"] : []
}

target "event-store-rust" {
  context = "./services/.rust/event-store"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/event-store-rust:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/event-store-rust:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/event-store-rust:buildcache", "type=registry,ref=${REGISTRY}/infidraw/event-store-rust:latest"] : []
}

target "api-gateway-rust" {
  context = "./services/.rust/api-gateway"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/api-gateway-rust:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/api-gateway-rust:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/api-gateway-rust:buildcache", "type=registry,ref=${REGISTRY}/infidraw/api-gateway-rust:latest"] : []
}

target "realtime-service-rust" {
  context = "./services/.rust/realtime-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/realtime-service-rust:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/realtime-service-rust:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/realtime-service-rust:buildcache", "type=registry,ref=${REGISTRY}/infidraw/realtime-service-rust:latest"] : []
}

target "tile-service-rust" {
  context = "./services/.rust/tile-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/tile-service-rust:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/tile-service-rust:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/tile-service-rust:buildcache", "type=registry,ref=${REGISTRY}/infidraw/tile-service-rust:latest"] : []
}

target "snapshot-worker-rust" {
  context = "./services/.rust/snapshot-worker"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/snapshot-worker-rust:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/snapshot-worker-rust:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/snapshot-worker-rust:buildcache", "type=registry,ref=${REGISTRY}/infidraw/snapshot-worker-rust:latest"] : []
}

target "metrics-service-rust" {
  context = "./services/.rust/metrics-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/metrics-service-rust:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/metrics-service-rust:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/metrics-service-rust:buildcache", "type=registry,ref=${REGISTRY}/infidraw/metrics-service-rust:latest"] : []
}

target "admin-service-rust" {
  context = "./services/.rust/admin-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/admin-service-rust:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/admin-service-rust:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/admin-service-rust:buildcache", "type=registry,ref=${REGISTRY}/infidraw/admin-service-rust:latest"] : []
}

target "frontend-v2" {
  context = "./frontend-v2"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/frontend-v2:${TAG}"]
  cache-to = concat(["type=inline"], USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/frontend-v2:buildcache,mode=max"] : [])
  cache-from = USE_REGISTRY_CACHE == "1" ? ["type=registry,ref=${REGISTRY}/infidraw/frontend-v2:buildcache", "type=registry,ref=${REGISTRY}/infidraw/frontend-v2:latest"] : []
}
