//! Metrics-service (Rust): Postgres, MinIO, Redis metrics. JSON and Prometheus. Parity with Node.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tracing_subscriber::EnvFilter;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::Client as S3Client;

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    redis: Arc<tokio::sync::Mutex<redis::aio::ConnectionManager>>,
    s3: S3Client,
    bucket: String,
}

#[derive(Serialize)]
struct PostgresMetrics {
    database_size: i64,
    table_size: i64,
    event_count: i64,
    oldest_event: Option<i64>,
    newest_event: Option<i64>,
}

#[derive(Serialize)]
struct MinioMetrics {
    bucket_size: i64,
    object_count: i64,
    average_object_size: f64,
}

#[derive(Serialize)]
struct RedisMetrics {
    used_memory: i64,
    used_memory_human: String,
    connected_clients: i64,
}

async fn get_postgres_metrics(pool: &PgPool) -> Result<PostgresMetrics, sqlx::Error> {
    let db_size: (i64,) = sqlx::query_as("SELECT pg_database_size('infidraw')::bigint")
        .fetch_one(pool)
        .await?;
    let table_size: (i64,) = sqlx::query_as("SELECT pg_total_relation_size('stroke_events')::bigint")
        .fetch_one(pool)
        .await?;
    let count_old_new: (i64, Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT COUNT(*)::bigint, MIN(timestamp)::bigint, MAX(timestamp)::bigint FROM stroke_events",
    )
    .fetch_one(pool)
    .await?;
    Ok(PostgresMetrics {
        database_size: db_size.0,
        table_size: table_size.0,
        event_count: count_old_new.0,
        oldest_event: count_old_new.1,
        newest_event: count_old_new.2,
    })
}

async fn get_minio_metrics(s3: &S3Client, bucket: &str) -> Result<MinioMetrics, Box<dyn std::error::Error + Send + Sync>> {
    let mut total_size: i64 = 0;
    let mut count: i64 = 0;
    let mut continuation: Option<String> = None;
    loop {
        let mut req = s3.list_objects_v2().bucket(bucket);
        if let Some(ref ct) = continuation {
            req = req.continuation_token(ct);
        }
        let out = req.send().await?;
        for obj in out.contents().iter() {
            count += 1;
            total_size += obj.size().unwrap_or(0) as i64;
        }
        continuation = out.next_continuation_token().map(String::from);
        if continuation.is_none() {
            break;
        }
    }
    let avg = if count > 0 {
        total_size as f64 / count as f64
    } else {
        0.0
    };
    Ok(MinioMetrics {
        bucket_size: total_size,
        object_count: count,
        average_object_size: avg,
    })
}

fn format_bytes(bytes: i64) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
    const K: f64 = 1024.0;
    let b = bytes as f64;
    let units = ["B", "KB", "MB", "GB", "TB"];
    let i = (b.ln() / K.ln()).floor().min(4.0).max(0.0) as usize;
    let v = b / K.powi(i as i32);
    format!("{} {}", (v * 100.0).round() / 100.0, units[i])
}

async fn get_redis_metrics(
    redis: &mut redis::aio::ConnectionManager,
) -> Result<RedisMetrics, redis::RedisError> {
    let info_mem: String = redis::cmd("INFO").arg("memory").query_async(redis).await?;
    let info_clients: String = redis::cmd("INFO").arg("clients").query_async(redis).await?;
    let mut used_memory: i64 = 0;
    let mut used_memory_human = "0B".to_string();
    let mut connected_clients: i64 = 0;
    for line in info_mem.lines() {
        let line = line.trim_end_matches('\r');
        if line.starts_with("used_memory:") {
            used_memory = line.trim_start_matches("used_memory:").trim().trim_end_matches('\r').parse().unwrap_or(0);
        } else if line.starts_with("used_memory_human:") {
            used_memory_human = line
                .trim_start_matches("used_memory_human:")
                .trim()
                .trim_end_matches('\r')
                .to_string();
        }
    }
    for line in info_clients.lines() {
        let line = line.trim_end_matches('\r');
        if line.starts_with("connected_clients:") {
            connected_clients = line
                .trim_start_matches("connected_clients:")
                .trim()
                .trim_end_matches('\r')
                .parse()
                .unwrap_or(0);
        }
    }
    Ok(RedisMetrics {
        used_memory,
        used_memory_human,
        connected_clients,
    })
}

fn prometheus_output(postgres: &PostgresMetrics, minio: &MinioMetrics, redis: &RedisMetrics) -> String {
    let total = postgres.database_size + minio.bucket_size + redis.used_memory;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64();
    format!(
        r#"# HELP infidraw_postgres_database_size_bytes PostgreSQL database size in bytes
# TYPE infidraw_postgres_database_size_bytes gauge
infidraw_postgres_database_size_bytes {}

# HELP infidraw_postgres_table_size_bytes PostgreSQL stroke_events table size in bytes
# TYPE infidraw_postgres_table_size_bytes gauge
infidraw_postgres_table_size_bytes {}

# HELP infidraw_postgres_events_total Total number of stroke events in PostgreSQL
# TYPE infidraw_postgres_events_total counter
infidraw_postgres_events_total {}

# HELP infidraw_postgres_oldest_event_timestamp Timestamp of the oldest event in PostgreSQL
# TYPE infidraw_postgres_oldest_event_timestamp gauge
infidraw_postgres_oldest_event_timestamp {}

# HELP infidraw_postgres_newest_event_timestamp Timestamp of the newest event in PostgreSQL
# TYPE infidraw_postgres_newest_event_timestamp gauge
infidraw_postgres_newest_event_timestamp {}

# HELP infidraw_minio_bucket_size_bytes MinIO bucket size in bytes
# TYPE infidraw_minio_bucket_size_bytes gauge
infidraw_minio_bucket_size_bytes {}

# HELP infidraw_minio_objects_total Total number of objects in MinIO bucket
# TYPE infidraw_minio_objects_total counter
infidraw_minio_objects_total {}

# HELP infidraw_minio_average_object_size_bytes Average object size in MinIO bucket
# TYPE infidraw_minio_average_object_size_bytes gauge
infidraw_minio_average_object_size_bytes {}

# HELP infidraw_redis_memory_bytes Redis used memory in bytes
# TYPE infidraw_redis_memory_bytes gauge
infidraw_redis_memory_bytes {}

# HELP infidraw_redis_connected_clients Number of connected Redis clients
# TYPE infidraw_redis_connected_clients gauge
infidraw_redis_connected_clients {}

# HELP infidraw_total_size_bytes Total storage size across all services in bytes
# TYPE infidraw_total_size_bytes gauge
infidraw_total_size_bytes {}

# HELP infidraw_metrics_scrape_timestamp Timestamp when metrics were scraped
# TYPE infidraw_metrics_scrape_timestamp gauge
infidraw_metrics_scrape_timestamp {}
"#,
        postgres.database_size,
        postgres.table_size,
        postgres.event_count,
        postgres.oldest_event.unwrap_or(0) / 1000,
        postgres.newest_event.unwrap_or(0) / 1000,
        minio.bucket_size,
        minio.object_count,
        minio.average_object_size as i64,
        redis.used_memory,
        redis.connected_clients,
        total,
        ts
    )
}

async fn get_metrics(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let postgres = get_postgres_metrics(&state.pool).await.map_err(|e| {
        tracing::error!("postgres metrics: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to fetch metrics" })),
        )
    })?;
    let minio = get_minio_metrics(&state.s3, &state.bucket).await.map_err(|e| {
        tracing::error!("minio metrics: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to fetch metrics" })),
        )
    })?;
    let mut redis_guard = state.redis.lock().await;
    let redis = get_redis_metrics(&mut *redis_guard).await.map_err(|e| {
        tracing::error!("redis metrics: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to fetch metrics" })),
        )
    })?;

    let want_prometheus = params.get("format").map(|s| s.as_str()) == Some("prometheus")
        || headers
            .get("accept")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.contains("text/plain"))
            .unwrap_or(false);

    if want_prometheus {
        let body = prometheus_output(&postgres, &minio, &redis);
        return Ok((
            [(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
            body,
        ));
    }

    let total_size = postgres.database_size + minio.bucket_size + redis.used_memory;
    Ok(Json(serde_json::json!({
        "postgres": {
            "databaseSize": postgres.database_size,
            "tableSize": postgres.table_size,
            "eventCount": postgres.event_count,
            "oldestEvent": postgres.oldest_event,
            "newestEvent": postgres.newest_event
        },
        "minio": {
            "bucketSize": minio.bucket_size,
            "objectCount": minio.object_count,
            "averageObjectSize": minio.average_object_size
        },
        "redis": {
            "usedMemory": redis.used_memory,
            "usedMemoryHuman": redis.used_memory_human,
            "connectedClients": redis.connected_clients
        },
        "totalSize": total_size,
        "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
    })))
}

async fn get_metrics_summary(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let postgres = get_postgres_metrics(&state.pool).await.map_err(|e| {
        tracing::error!("postgres: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Failed to fetch metrics" })))
    })?;
    let minio = get_minio_metrics(&state.s3, &state.bucket).await.map_err(|e| {
        tracing::error!("minio: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Failed to fetch metrics" })))
    })?;
    let mut redis_guard = state.redis.lock().await;
    let redis = get_redis_metrics(&mut *redis_guard).await.map_err(|e| {
        tracing::error!("redis: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Failed to fetch metrics" })))
    })?;
    let total_size = postgres.database_size + minio.bucket_size + redis.used_memory;
    Ok(Json(serde_json::json!({
        "totalSize": total_size,
        "totalSizeFormatted": format_bytes(total_size),
        "breakdown": {
            "postgres": { "size": postgres.database_size, "sizeFormatted": format_bytes(postgres.database_size), "events": postgres.event_count },
            "minio": { "size": minio.bucket_size, "sizeFormatted": format_bytes(minio.bucket_size), "objects": minio.object_count },
            "redis": { "size": redis.used_memory, "sizeFormatted": redis.used_memory_human, "clients": redis.connected_clients }
        },
        "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
    })))
}

async fn get_metrics_postgres(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let m = get_postgres_metrics(&state.pool).await.map_err(|e| {
        tracing::error!("postgres: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Failed to fetch metrics" })))
    })?;
    Ok(Json(serde_json::json!({
        "databaseSize": m.database_size,
        "databaseSizeFormatted": format_bytes(m.database_size),
        "tableSize": m.table_size,
        "tableSizeFormatted": format_bytes(m.table_size),
        "eventCount": m.event_count,
        "oldestEvent": m.oldest_event,
        "newestEvent": m.newest_event
    })))
}

async fn get_metrics_minio(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let m = get_minio_metrics(&state.s3, &state.bucket).await.map_err(|e| {
        tracing::error!("minio: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Failed to fetch metrics" })))
    })?;
    Ok(Json(serde_json::json!({
        "bucketSize": m.bucket_size,
        "bucketSizeFormatted": format_bytes(m.bucket_size),
        "objectCount": m.object_count,
        "averageObjectSize": m.average_object_size,
        "averageObjectSizeFormatted": format_bytes(m.average_object_size as i64)
    })))
}

async fn get_metrics_redis(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let mut redis_guard = state.redis.lock().await;
    let m = get_redis_metrics(&mut *redis_guard).await.map_err(|e| {
        tracing::error!("redis: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Failed to fetch metrics" })))
    })?;
    Ok(Json(serde_json::json!({
        "usedMemory": m.used_memory,
        "usedMemoryFormatted": format_bytes(m.used_memory),
        "usedMemoryHuman": m.used_memory_human,
        "connectedClients": m.connected_clients
    })))
}

async fn get_metrics_prometheus(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let postgres = get_postgres_metrics(&state.pool).await.map_err(|e| {
        tracing::error!("postgres: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, "# Error fetching metrics\n".to_string())
    })?;
    let minio = get_minio_metrics(&state.s3, &state.bucket).await.map_err(|e| {
        tracing::error!("minio: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, "# Error fetching metrics\n".to_string())
    })?;
    let mut redis_guard = state.redis.lock().await;
    let redis = get_redis_metrics(&mut *redis_guard).await.map_err(|e| {
        tracing::error!("redis: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, "# Error fetching metrics\n".to_string())
    })?;
    let body = prometheus_output(&postgres, &minio, &redis);
    Ok((
        [(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        body,
    ))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

fn s3_client_from_env() -> Result<S3Client, Box<dyn std::error::Error + Send + Sync>> {
    let endpoint = std::env::var("MINIO_ENDPOINT").unwrap_or_else(|_| "minio:9000".to_string());
    let (host, port) = if let Some((h, p)) = endpoint.split_once(':') {
        (h.to_string(), p.to_string())
    } else {
        (endpoint, "9000".to_string())
    };
    let url = format!("http://{}:{}", host, port);
    let access_key = std::env::var("MINIO_ACCESS_KEY").unwrap_or_else(|_| "minioadmin".to_string());
    let secret_key = std::env::var("MINIO_SECRET_KEY").unwrap_or_else(|_| "minioadmin".to_string());
    let creds = aws_credential_types::Credentials::new(access_key, secret_key, None, None, "env");
    let cfg = aws_sdk_s3::Config::builder()
        .region(Region::new("us-east-1"))
        .credentials_provider(creds)
        .endpoint_url(&url)
        .force_path_style(true)
        .build();
    Ok(S3Client::from_conf(cfg))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("metrics_service=info".parse()?))
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://infidraw:infidraw_dev@localhost:5432/infidraw".to_string());
    let redis_url =
        std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    let bucket = std::env::var("MINIO_BUCKET").unwrap_or_else(|_| "tile-snapshots".to_string());
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&database_url)
        .await?;
    let redis_client = redis::Client::open(redis_url)?;
    let redis_manager = redis_client.get_tokio_connection_manager().await?;
    let s3 = s3_client_from_env()?;

    let state = Arc::new(AppState {
        pool,
        redis: Arc::new(tokio::sync::Mutex::new(redis_manager)),
        s3,
        bucket,
    });

    let app = Router::new()
        .route("/metrics", get(get_metrics))
        .route("/metrics/summary", get(get_metrics_summary))
        .route("/metrics/postgres", get(get_metrics_postgres))
        .route("/metrics/minio", get(get_metrics_minio))
        .route("/metrics/redis", get(get_metrics_redis))
        .route("/metrics/prometheus", get(get_metrics_prometheus))
        .route("/health", get(health))
        .with_state(state);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Metrics Service (Rust) running on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
