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

group "rust" {
  targets = [
    "event-store-rust",
    "api-gateway-rust",
    "realtime-service-rust",
    "tile-service-rust",
    "snapshot-worker-rust",
    "metrics-service-rust",
    "admin-service-rust"
  ]
}

#########################################################################

variable "REGISTRY" {
  default = "reg.serabass.kz"
}

variable "TAG" {
  default = "latest"
}

variable "USE_REGISTRY_CACHE" {
  default = "1"
}

#########################################################################

function "cache_from" {
  params = [name]
  result = USE_REGISTRY_CACHE == "1" ? [
    "type=registry,ref=${REGISTRY}/infidraw/${name}:buildcache",
    "type=registry,ref=${REGISTRY}/infidraw/${name}:latest"
  ] : []
}

function "cache_to" {
  params = [name]
  result = concat(
    ["type=inline"],
    USE_REGISTRY_CACHE == "1" ? [
      "type=registry,ref=${REGISTRY}/infidraw/${name}:buildcache,mode=max"
    ] : []
  )
}

#########################################################################

target "event-store" {
  context = "./services/event-store"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/event-store:${TAG}"]
  cache-to = cache_to("event-store")
  cache-from = cache_from("event-store")
}

target "api-gateway" {
  context = "./services/api-gateway"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/api-gateway:${TAG}"]
  cache-to = cache_to("api-gateway")
  cache-from = cache_from("api-gateway")
}

target "realtime-service" {
  context = "./services/realtime-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/realtime-service:${TAG}"]
  cache-to = cache_to("realtime-service")
  cache-from = cache_from("realtime-service")
}

target "tile-service" {
  context = "./services/tile-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/tile-service:${TAG}"]
  cache-to = cache_to("tile-service")
  cache-from = cache_from("tile-service")
}

target "snapshot-worker" {
  context = "./services/snapshot-worker"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/snapshot-worker:${TAG}"]
  cache-to = cache_to("snapshot-worker")
  cache-from = cache_from("snapshot-worker")
}

target "metrics-service" {
  context = "./services/metrics-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/metrics-service:${TAG}"]
  cache-to = cache_to("metrics-service")
  cache-from = cache_from("metrics-service")
}

target "admin-service" {
  context = "./services/admin-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/admin-service:${TAG}"]
  cache-to = cache_to("admin-service")
  cache-from = cache_from("admin-service")
}

target "event-store-rust" {
  context = "./services/.rust/event-store"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/rust/event-store:${TAG}"]
  cache-to = cache_to("event-store-rust")
  cache-from = cache_from("event-store-rust")
}

target "api-gateway-rust" {
  context = "./services/.rust/api-gateway"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/rust/api-gateway:${TAG}"]
  cache-to = cache_to("api-gateway-rust")
  cache-from = cache_from("api-gateway-rust")
}

target "realtime-service-rust" {
  context = "./services/.rust/realtime-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/rust/realtime-service:${TAG}"]
  cache-to = cache_to("realtime-service-rust")
  cache-from = cache_from("realtime-service-rust")
}

target "tile-service-rust" {
  context = "./services/.rust/tile-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/rust/tile-service:${TAG}"]
  cache-to = cache_to("tile-service-rust")
  cache-from = cache_from("tile-service-rust")
}

target "snapshot-worker-rust" {
  context = "./services/.rust/snapshot-worker"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/rust/snapshot-worker:${TAG}"]
  cache-to = cache_to("snapshot-worker-rust")
  cache-from = cache_from("snapshot-worker-rust")
}

target "metrics-service-rust" {
  context = "./services/.rust/metrics-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/rust/metrics-service:${TAG}"]
  cache-to = cache_to("metrics-service-rust")
  cache-from = cache_from("metrics-service-rust")
}

target "admin-service-rust" {
  context = "./services/.rust/admin-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/rust/admin-service:${TAG}"]
  cache-to = cache_to("admin-service-rust")
  cache-from = cache_from("admin-service-rust")
}

target "frontend-v2" {
  context = "./frontend-v2"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/frontend-v2:${TAG}"]
  cache-to = cache_to("frontend-v2")
  cache-from = cache_from("frontend-v2")
}
