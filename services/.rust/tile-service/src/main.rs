//! Tile-service (Rust): GET /tiles, GET /snapshots/:key. Postgres + MinIO + snapshot-worker for render.
//! API parity with Node; rendering delegated to snapshot-worker.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;
use tracing_subscriber::EnvFilter;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::Client as S3Client;

const DEFAULT_ROOM: &str = "1";
const TILE_SIZE: i32 = 512;
const TILE_ID_OFFSET: i64 = 500_000;
const MAX_TILES: usize = 100;

fn encode_tile_id(tile_x: i32, tile_y: i32) -> i64 {
    (tile_x as i64 + TILE_ID_OFFSET) * 1_000_000 + (tile_y as i64 + TILE_ID_OFFSET)
}

fn tile_coords(world_x: f64, world_y: f64) -> (i32, i32) {
    (
        (world_x / TILE_SIZE as f64).floor() as i32,
        (world_y / TILE_SIZE as f64).floor() as i32,
    )
}

fn tile_bbox(tile_x: i32, tile_y: i32) -> (f64, f64, f64, f64) {
    let x1 = tile_x as f64 * TILE_SIZE as f64;
    let y1 = tile_y as f64 * TILE_SIZE as f64;
    (x1, y1, x1 + TILE_SIZE as f64, y1 + TILE_SIZE as f64)
}

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    s3: S3Client,
    bucket: String,
    snapshot_worker_url: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Stroke {
    id: String,
    ts: i64,
    tool: String,
    color: String,
    width: f64,
    points: Vec<[f64; 2]>,
    author_id: Option<String>,
    hidden: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderRequest {
    tile_x: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tile_x_alt: Option<i32>,
    tile_y: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tile_y_alt: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tile_size: Option<u32>,
    strokes: Vec<Stroke>,
}

async fn get_strokes_for_tile(
    pool: &PgPool,
    room_id: &str,
    tile_x: i32,
    tile_y: i32,
    since_version: Option<i64>,
) -> Result<Vec<Stroke>, sqlx::Error> {
    let tile_id = encode_tile_id(tile_x, tile_y);
    let (x1, y1, x2, y2) = tile_bbox(tile_x, tile_y);

    let tile_events = sqlx::query_as::<_, (String, String, serde_json::Value, i64)>(
        "SELECT event_type, stroke_id, payload, ts FROM tile_events WHERE room_id = $1 AND tile_id = $2 ORDER BY id ASC LIMIT 50000",
    )
    .bind(room_id)
    .bind(tile_id)
    .fetch_all(pool)
    .await?;

    if !tile_events.is_empty() {
        let mut strokes: std::collections::HashMap<String, Stroke> = std::collections::HashMap::new();
        let mut last_ts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for (event_type, stroke_id, payload, ts) in tile_events {
            last_ts.insert(stroke_id.clone(), ts);
            if event_type == "stroke_created" {
                if let Some(stroke) = payload.get("id").and_then(|v| v.as_str()) {
                    let hidden = payload.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
                    if !hidden {
                        let points: Vec<[f64; 2]> = payload
                            .get("points")
                            .and_then(|p| p.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_array())
                                    .filter_map(|a| {
                                        let x = a.get(0).and_then(|v| v.as_f64())?;
                                        let y = a.get(1).and_then(|v| v.as_f64())?;
                                        Some([x, y])
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        strokes.insert(
                            stroke_id,
                            Stroke {
                                id: stroke.to_string(),
                                ts,
                                tool: payload.get("tool").and_then(|v| v.as_str()).unwrap_or("pen").to_string(),
                                color: payload.get("color").and_then(|v| v.as_str()).unwrap_or("#000000").to_string(),
                                width: payload.get("width").and_then(|v| v.as_f64()).unwrap_or(2.0),
                                points,
                                author_id: payload.get("authorId").and_then(|v| v.as_str()).map(String::from),
                                hidden: Some(hidden),
                            },
                        );
                    }
                }
            } else if event_type == "stroke_erased" {
                if let Some(indices) = payload.get("hiddenPointIndices").and_then(|v| v.as_array()) {
                    let set: std::collections::HashSet<usize> = indices
                        .iter()
                        .filter_map(|v| v.as_u64().map(|u| u as usize))
                        .collect();
                    if let Some(s) = strokes.get_mut(&stroke_id) {
                        s.points = s
                            .points
                            .iter()
                            .enumerate()
                            .filter(|(i, _)| !set.contains(i))
                            .map(|(_, p)| *p)
                            .collect();
                        if s.points.is_empty() {
                            strokes.remove(&stroke_id);
                        }
                    }
                }
            }
        }
        let mut list: Vec<Stroke> = strokes.into_values().collect();
        let (x1, y1, x2, y2) = tile_bbox(tile_x, tile_y);
        list.retain(|s| s.points.iter().any(|[x, y]| *x >= x1 && *x < x2 && *y >= y1 && *y < y2));
        if let Some(sv) = since_version {
            list.retain(|s| last_ts.get(&s.id).copied().unwrap_or(0) > sv);
        }
        return Ok(list);
    }

    let since_sql = if since_version.is_some() { "AND timestamp > $6" } else { "" };
    let query = format!(
        r#"
        SELECT stroke_data, timestamp FROM stroke_events
        WHERE room_id = $1 AND event_type = 'stroke_created'
          AND stroke_data->>'hidden' IS DISTINCT FROM 'true'
          AND min_x IS NOT NULL AND max_x IS NOT NULL AND min_y IS NOT NULL AND max_y IS NOT NULL
          AND NOT (max_x < $2 OR min_x >= $3 OR max_y < $4 OR min_y >= $5)
          {}
        ORDER BY timestamp DESC LIMIT 10000
        "#,
        since_sql
    );
    let rows = if let Some(sv) = since_version {
        sqlx::query_as::<_, (serde_json::Value, i64)>(&query)
            .bind(room_id)
            .bind(x1)
            .bind(x2)
            .bind(y1)
            .bind(y2)
            .bind(sv)
            .fetch_all(pool)
            .await?
    } else {
        sqlx::query_as::<_, (serde_json::Value, i64)>(&query)
            .bind(room_id)
            .bind(x1)
            .bind(x2)
            .bind(y1)
            .bind(y2)
            .fetch_all(pool)
            .await?
    };
    let strokes: Vec<Stroke> = rows
        .into_iter()
        .filter_map(|(data, _)| {
            let points: Vec<[f64; 2]> = data.get("points")?.as_array()?.iter().filter_map(|v| {
                let a = v.as_array()?;
                Some([a.get(0)?.as_f64()?, a.get(1)?.as_f64()?])
            }).collect();
            Some(Stroke {
                id: data.get("id")?.as_str()?.to_string(),
                ts: data.get("ts")?.as_i64()?,
                tool: data.get("tool")?.as_str()?.to_string(),
                color: data.get("color")?.as_str()?.to_string(),
                width: data.get("width")?.as_f64()?,
                points,
                author_id: data.get("authorId").and_then(|v| v.as_str()).map(String::from),
                hidden: data.get("hidden").and_then(|v| v.as_bool()),
            })
        })
        .filter(|s| s.points.iter().any(|[x, y]| *x >= x1 && *x < x2 && *y >= y1 && *y < y2))
        .collect();
    Ok(strokes)
}

async fn render_via_worker(url: &str, tile_x: i32, tile_y: i32, strokes: &[Stroke]) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let req = RenderRequest {
        tile_x,
        tile_x_alt: None,
        tile_y,
        tile_y_alt: None,
        tile_size: Some(TILE_SIZE as u32),
        strokes: strokes.to_vec(),
    };
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/render", url.trim_end_matches('/')))
        .json(&req)
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(format!("snapshot-worker returned {}", res.status()).into());
    }
    let bytes = res.bytes().await?;
    Ok(bytes.to_vec())
}

fn s3_client_from_env() -> Result<S3Client, Box<dyn std::error::Error + Send + Sync>> {
    let endpoint = std::env::var("MINIO_ENDPOINT").unwrap_or_else(|_| "minio:9000".to_string());
    let (host, port) = endpoint.split_once(':').unwrap_or((endpoint.as_str(), "9000"));
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

#[derive(Deserialize)]
struct TilesQuery {
    #[serde(rename = "roomId")]
    room_id: Option<String>,
    x1: Option<f64>,
    y1: Option<f64>,
    x2: Option<f64>,
    y2: Option<f64>,
    #[serde(rename = "sinceVersion")]
    since_version: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TileOut {
    tile_x: i32,
    tile_y: i32,
    version: i64,
    snapshot_url: Option<String>,
    strokes: Vec<Stroke>,
}

async fn get_tiles(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TilesQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let room_id = q.room_id.as_deref().unwrap_or(DEFAULT_ROOM);
    let (x1, y1, x2, y2) = match (q.x1, q.y1, q.x2, q.y2) {
        (Some(a), Some(b), Some(c), Some(d)) if a.is_finite() && b.is_finite() && c.is_finite() && d.is_finite() => (a, b, c, d),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Invalid coordinates" })),
            ));
        }
    };
    let since_version = q.since_version;

    let (min_tx, min_ty) = tile_coords(x1, y1);
    let (max_tx, max_ty) = tile_coords(x2, y2);
    let mut tile_coords_list = Vec::new();
    for tx in min_tx..=max_tx {
        for ty in min_ty..=max_ty {
            tile_coords_list.push((tx, ty));
        }
    }
    if tile_coords_list.len() > MAX_TILES {
        tile_coords_list.truncate(MAX_TILES);
    }

    let worker_url = state.snapshot_worker_url.as_deref();
    let mut tiles_out = Vec::new();
    for (tile_x, tile_y) in tile_coords_list {
        let latest = sqlx::query_as::<_, (Option<String>, Option<i64>)>(
            "SELECT snapshot_url, version FROM tile_snapshots WHERE room_id = $1 AND tile_x = $2 AND tile_y = $3 ORDER BY version DESC LIMIT 1",
        )
        .bind(room_id)
        .bind(tile_x)
        .bind(tile_y)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| {
            tracing::error!("tile_snapshots: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Internal server error" })))
        })?;

        let (snapshot_url, version, strokes) = match latest {
            Some((Some(url), Some(ver))) if since_version.map(|sv| ver >= sv).unwrap_or(true) => {
                (Some(url), ver, vec![])
            }
            _ => {
                let strokes = get_strokes_for_tile(&state.pool, room_id, tile_x, tile_y, since_version).await.map_err(|e| {
                    tracing::error!("get_strokes: {}", e);
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Internal server error" })))
                })?;
                let version = latest.as_ref().and_then(|(_, v)| *v).unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64);
                let snapshot_url = if strokes.is_empty() {
                    latest.and_then(|(u, _)| u)
                } else if let Some(url) = worker_url {
                    match render_via_worker(url, tile_x, tile_y, &strokes).await {
                        Ok(png) => {
                            let key = format!("room_{}/tile_{}_{}_{}.png", room_id, tile_x, tile_y, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64);
                            let _ = state.s3.put_object().bucket(&state.bucket).key(&key).body(aws_sdk_s3::primitives::ByteStream::from(png)).content_type("image/png").send().await;
                            let _ = sqlx::query("INSERT INTO tile_snapshots (room_id, tile_x, tile_y, version, snapshot_url) VALUES ($1, $2, $3, $4, $5)")
                                .bind(room_id)
                                .bind(tile_x)
                                .bind(tile_y)
                                .bind(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64)
                                .bind(format!("/snapshots/{}", key))
                                .execute(&state.pool)
                                .await;
                            Some(format!("/snapshots/{}", key))
                        }
                        Err(e) => {
                            tracing::warn!("snapshot-worker failed: {}", e);
                            None
                        }
                    }
                } else {
                    None
                };
                (snapshot_url, version, strokes)
            }
        };

        tiles_out.push(TileOut {
            tile_x,
            tile_y,
            version,
            snapshot_url,
            strokes,
        });
    }

    Ok(Json(serde_json::json!({ "tiles": tiles_out })))
}

async fn get_snapshot(
    State(state): State<Arc<AppState>>,
    Path((a, b)): Path<(String, String)>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let key = format!("{}/{}", a, b);
    let key = urlencoding::decode(&key).unwrap_or(std::borrow::Cow::Borrowed(key.as_str())).into_owned();
    let out = state.s3.get_object().bucket(&state.bucket).key(&key).send().await.map_err(|e| {
        if e.to_string().contains("NoSuchKey") {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Snapshot not found" })))
        } else {
            tracing::error!("get_object: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Internal server error" })))
        }
    })?;
    let body = out.body.collect().await.map_err(|e| {
        tracing::error!("body: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Internal server error" })))
    })?.into_bytes();
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "image/png"),
            (axum::http::header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        body.to_vec(),
    ))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("tile_service=info".parse()?))
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://infidraw:infidraw_dev@localhost:5432/infidraw".to_string());
    let bucket = std::env::var("MINIO_BUCKET").unwrap_or_else(|_| "tile-snapshots".to_string());
    let snapshot_worker_url = std::env::var("SNAPSHOT_WORKER_URL").ok();
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&database_url)
        .await?;
    let s3 = s3_client_from_env()?;

    let state = Arc::new(AppState {
        pool,
        s3,
        bucket,
        snapshot_worker_url,
    });

    let app = Router::new()
        .route("/tiles", get(get_tiles))
        .route("/snapshots/:a/:b", get(get_snapshot))
        .route("/health", get(health))
        .with_state(state);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Tile Service (Rust) running on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
