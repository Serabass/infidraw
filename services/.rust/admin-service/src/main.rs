//! Admin-service (Rust): cleanup, stats. Postgres + Redis + MinIO. API parity with Node.

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use redis::AsyncCommands;
use serde::Deserialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tracing_subscriber::EnvFilter;
use aws_sdk_s3::config::{Builder as S3ConfigBuilder, Region};
use aws_sdk_s3::Client as S3Client;
use aws_sdk_s3::types::ObjectIdentifier;

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    redis: Arc<tokio::sync::Mutex<redis::aio::ConnectionManager>>,
    s3: S3Client,
    bucket: String,
    admin_token: String,
}

fn require_admin(
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    token: &str,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let auth = headers
        .get("x-admin-token")
        .and_then(|v| v.to_str().ok())
        .or_else(|| query.get("token").map(|s| s.as_str()));
    match auth {
        Some(t) if t == token => Ok(()),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Unauthorized" })),
        )),
    }
}

#[derive(Deserialize)]
struct CleanupOldBody {
    days: Option<i64>,
}

async fn post_cleanup_old(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Option<Json<CleanupOldBody>>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&headers, &query, &state.admin_token)?;
    let days = body
        .and_then(|b| b.days)
        .or_else(|| query.get("days").and_then(|d| d.parse().ok()))
        .unwrap_or(7);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let cutoff = now_ms - days * 24 * 60 * 60 * 1000;

    let result = sqlx::query(
        "DELETE FROM stroke_events WHERE timestamp < $1 RETURNING id, stroke_id",
    )
    .bind(cutoff)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("cleanup-old: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;
    let deleted = result.rows_affected() as i64;
    let cutoff_date = format!("{}", cutoff);

    Ok(Json(serde_json::json!({
        "success": true,
        "deletedEvents": deleted,
        "cutoffTimestamp": cutoff,
        "cutoffDate": cutoff_date,
        "days": days,
        "message": format!("Deleted {} events older than {} days (before {})", deleted, days, cutoff_date)
    })))
}

async fn post_cleanup_all(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&headers, &query, &state.admin_token)?;

    let events_result = sqlx::query("DELETE FROM stroke_events RETURNING id")
        .execute(&state.pool)
        .await
        .map_err(|e| {
            tracing::error!("cleanup-all events: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Internal server error" })),
            )
        })?;
    let deleted_events = events_result.rows_affected() as i64;

    let snapshots_result = sqlx::query("DELETE FROM tile_snapshots RETURNING snapshot_url")
        .execute(&state.pool)
        .await
        .map_err(|e| {
            tracing::error!("cleanup-all snapshots: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Internal server error" })),
            )
        })?;
    let deleted_snapshots = snapshots_result.rows_affected() as i64;

    let mut deleted_objects: i64 = 0;
    let mut continuation: Option<String> = None;
    let mut all_keys = Vec::new();
    loop {
        let mut list_req = state.s3.list_objects_v2().bucket(&state.bucket);
        if let Some(ref ct) = continuation {
            list_req = list_req.continuation_token(ct);
        }
        let list = list_req.send().await.map_err(|e| {
            tracing::error!("list s3: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to list MinIO" })),
            )
        })?;
        for obj in list.contents().iter() {
            if let Some(k) = obj.key() {
                all_keys.push(
                    ObjectIdentifier::builder()
                        .key(k)
                        .build()
                        .map_err(|_| {
                            (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                Json(serde_json::json!({ "error": "build key" })),
                            )
                        })?,
                );
            }
        }
        continuation = list.next_continuation_token().map(String::from);
        if continuation.is_none() {
            break;
        }
    }
    for chunk in all_keys.chunks(1000) {
        let _ = state
            .s3
            .delete_objects()
            .bucket(&state.bucket)
            .delete(
                aws_sdk_s3::types::Delete::builder()
                    .set_objects(Some(chunk.to_vec()))
                    .build(),
            )
            .send()
            .await;
        deleted_objects += chunk.len() as i64;
    }

    let _: Result<(), _> = state.redis.lock().await.flushdb::<()>().await;

    Ok(Json(serde_json::json!({
        "success": true,
        "deletedEvents": deleted_events,
        "deletedSnapshots": deleted_snapshots,
        "deletedObjects": deleted_objects,
        "message": format!("Cleaned up everything: {} events, {} snapshots, {} objects", deleted_events, deleted_snapshots, deleted_objects)
    })))
}

async fn get_admin_stats(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&headers, &query, &state.admin_token)?;

    let total_events: (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM stroke_events")
        .fetch_one(&state.pool)
        .await
        .map_err(|e| {
            tracing::error!("stats events: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Internal server error" })),
            )
        })?;
    let oldest: (Option<i64>,) = sqlx::query_as("SELECT MIN(timestamp)::bigint FROM stroke_events")
        .fetch_one(&state.pool)
        .await
        .map_err(|e| {
            tracing::error!("stats oldest: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Internal server error" })),
            )
        })?;
    let newest: (Option<i64>,) = sqlx::query_as("SELECT MAX(timestamp)::bigint FROM stroke_events")
        .fetch_one(&state.pool)
        .await
        .map_err(|e| {
            tracing::error!("stats newest: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Internal server error" })),
            )
        })?;
    let total_snapshots: (i64,) =
        sqlx::query_as("SELECT COUNT(*)::bigint FROM tile_snapshots")
            .fetch_one(&state.pool)
            .await
            .map_err(|e| {
                tracing::error!("stats snapshots: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "Internal server error" })),
                )
            })?;

    let mut minio_count: i64 = 0;
    let mut minio_size: i64 = 0;
    let mut continuation: Option<String> = None;
    loop {
        let mut list_req = state.s3.list_objects_v2().bucket(&state.bucket);
        if let Some(ref ct) = continuation {
            list_req = list_req.continuation_token(ct);
        }
        let out = list_req.send().await.map_err(|e| {
            tracing::error!("list s3 stats: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to list MinIO" })),
            )
        })?;
        for obj in out.contents().iter() {
            minio_count += 1;
            minio_size += obj.size().unwrap_or(0) as i64;
        }
        continuation = out.next_continuation_token().map(String::from);
        if continuation.is_none() {
            break;
        }
    }

    Ok(Json(serde_json::json!({
        "events": {
            "total": total_events.0,
            "oldest": oldest.0,
            "newest": newest.0
        },
        "snapshots": {
            "total": total_snapshots.0,
            "minioObjects": minio_count,
            "minioTotalSize": minio_size
        }
    })))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "service": "admin-service" }))
}

async fn index() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "service": "admin-service",
        "status": "running",
        "endpoints": {
            "health": "/health",
            "cleanupOld": "/admin/cleanup-old (POST, requires token)",
            "cleanupAll": "/admin/cleanup-all (POST, requires token)",
            "stats": "/admin/stats (GET, requires token)"
        }
    }))
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

    let creds = aws_credential_types::Credentials::new(
        access_key,
        secret_key,
        None,
        None,
        "env",
    );
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
        .with_env_filter(EnvFilter::from_default_env().add_directive("admin_service=info".parse()?))
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://infidraw:infidraw_dev@localhost:5432/infidraw".to_string());
    let redis_url =
        std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    let bucket = std::env::var("MINIO_BUCKET").unwrap_or_else(|_| "tile-snapshots".to_string());
    let admin_token = std::env::var("ADMIN_TOKEN").unwrap_or_else(|_| "dev-admin-token-change-in-production".to_string());
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
        admin_token,
    });

    let app = Router::new()
        .route("/", get(index))
        .route("/health", get(health))
        .route("/admin/cleanup-old", post(post_cleanup_old))
        .route("/admin/cleanup-all", post(post_cleanup_all))
        .route("/admin/stats", get(get_admin_stats))
        .with_state(state);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Admin Service (Rust) running on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
