group "default" {
  targets = [
    "event-store",
    "api-gateway",
    "realtime-service",
    "tile-service",
    "snapshot-worker",
    "metrics-service",
    "admin-service",
    "frontend-v2"
  ]
}

variable "REGISTRY" {
  default = "reg.home.local"
}

variable "TAG" {
  default = "latest"
}

target "event-store" {
  context = "./services/event-store"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/event-store:${TAG}"]
  cache-to = [
    "type=inline",
    "type=registry,ref=${REGISTRY}/infidraw/event-store:buildcache,mode=max",
  ]
  cache-from = [
    "type=registry,ref=${REGISTRY}/infidraw/event-store:buildcache",
    "type=registry,ref=${REGISTRY}/infidraw/event-store:latest",
  ]
}

target "api-gateway" {
  context = "./services/api-gateway"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/api-gateway:${TAG}"]
  cache-to = [
    "type=inline",
    "type=registry,ref=${REGISTRY}/infidraw/api-gateway:buildcache,mode=max",
  ]
  cache-from = [
    "type=registry,ref=${REGISTRY}/infidraw/api-gateway:buildcache",
    "type=registry,ref=${REGISTRY}/infidraw/api-gateway:latest",
  ]
}

target "realtime-service" {
  context = "./services/realtime-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/realtime-service:${TAG}"]
  cache-to = [
    "type=inline",
    "type=registry,ref=${REGISTRY}/infidraw/realtime-service:buildcache,mode=max",
  ]
  cache-from = [
    "type=registry,ref=${REGISTRY}/infidraw/realtime-service:buildcache",
    "type=registry,ref=${REGISTRY}/infidraw/realtime-service:latest",
  ]
}

target "tile-service" {
  context = "./services/tile-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/tile-service:${TAG}"]
  cache-to = [
    "type=inline",
    "type=registry,ref=${REGISTRY}/infidraw/tile-service:buildcache,mode=max",
  ]
  cache-from = [
    "type=registry,ref=${REGISTRY}/infidraw/tile-service:buildcache",
    "type=registry,ref=${REGISTRY}/infidraw/tile-service:latest",
  ]
}

target "snapshot-worker" {
  context = "./services/snapshot-worker"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/snapshot-worker:${TAG}"]
  cache-to = [
    "type=inline",
    "type=registry,ref=${REGISTRY}/infidraw/snapshot-worker:buildcache,mode=max",
  ]
  cache-from = [
    "type=registry,ref=${REGISTRY}/infidraw/snapshot-worker:buildcache",
    "type=registry,ref=${REGISTRY}/infidraw/snapshot-worker:latest",
  ]
}

target "metrics-service" {
  context = "./services/metrics-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/metrics-service:${TAG}"]
  cache-to = [
    "type=inline",
    "type=registry,ref=${REGISTRY}/infidraw/metrics-service:buildcache,mode=max",
  ]
  cache-from = [
    "type=registry,ref=${REGISTRY}/infidraw/metrics-service:buildcache",
    "type=registry,ref=${REGISTRY}/infidraw/metrics-service:latest",
  ]
}

target "admin-service" {
  context = "./services/admin-service"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/admin-service:${TAG}"]
  cache-to = [
    "type=inline",
    "type=registry,ref=${REGISTRY}/infidraw/admin-service:buildcache,mode=max",
  ]
  cache-from = [
    "type=registry,ref=${REGISTRY}/infidraw/admin-service:buildcache",
    "type=registry,ref=${REGISTRY}/infidraw/admin-service:latest",
  ]
}

target "frontend-v2" {
  context = "./frontend-v2"
  dockerfile = "Dockerfile"
  tags = ["${REGISTRY}/infidraw/frontend-v2:${TAG}"]
  cache-to = [
    "type=inline",
    "type=registry,ref=${REGISTRY}/infidraw/frontend-v2:buildcache,mode=max",
  ]
  cache-from = [
    "type=registry,ref=${REGISTRY}/infidraw/frontend-v2:buildcache",
    "type=registry,ref=${REGISTRY}/infidraw/frontend-v2:latest",
  ]
}
