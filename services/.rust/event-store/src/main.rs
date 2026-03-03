//! Event-store service: strokes, events, rooms, talkers. Postgres + Redis.
//! API parity with the TypeScript event-store.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use axum::body::Body;
use axum::http::Request;
use hyper::body::to_bytes;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

const DEFAULT_ROOM: &str = "1";
const TILE_SIZE: i32 = 512;
const TILE_ID_OFFSET: i64 = 500_000;
const EVENTS_FULL_CACHE_PREFIX: &str = "events:full:";
const EVENTS_FULL_CACHE_TTL_SEC: u64 = 10;

fn encode_tile_id(tile_x: i32, tile_y: i32) -> i64 {
    (tile_x as i64 + TILE_ID_OFFSET) * 1_000_000 + (tile_y as i64 + TILE_ID_OFFSET)
}

fn get_tile_ids_for_bbox(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Vec<i64> {
    let min_tile_x = (min_x / TILE_SIZE as f64).floor() as i32;
    let min_tile_y = (min_y / TILE_SIZE as f64).floor() as i32;
    let max_tile_x = (max_x / TILE_SIZE as f64).floor() as i32;
    let max_tile_y = (max_y / TILE_SIZE as f64).floor() as i32;
    let mut ids = Vec::new();
    for tx in min_tile_x..=max_tile_x {
        for ty in min_tile_y..=max_tile_y {
            ids.push(encode_tile_id(tx, ty));
        }
    }
    ids
}

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    redis: std::sync::Arc<tokio::sync::Mutex<redis::aio::ConnectionManager>>,
}

#[derive(Deserialize)]
struct StrokePoints(Vec<[f64; 2]>);

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Stroke {
    id: String,
    ts: i64,
    tool: String,
    color: String,
    width: f64,
    points: Vec<[f64; 2]>,
    author_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hidden: Option<bool>,
}

#[derive(Serialize)]
struct StrokeEventOut {
    #[serde(rename = "type")]
    event_type: String,
    stroke_id: String,
    stroke: Option<serde_json::Value>,
    timestamp: i64,
}

#[derive(Deserialize)]
struct CreateStrokeBody {
    tool: String,
    color: String,
    width: f64,
    points: Vec<[f64; 2]>,
    #[serde(rename = "authorId")]
    author_id: Option<String>,
    #[serde(rename = "roomId")]
    room_id: Option<String>,
}

#[derive(Deserialize)]
struct EraseBody {
    hidden_point_indices: Vec<u32>,
    #[serde(rename = "roomId")]
    room_id: Option<String>,
}

#[derive(Deserialize)]
struct RoomNameBody {
    name: String,
}

#[derive(Deserialize)]
struct TalkerCreateBody {
    #[serde(rename = "roomId")]
    room_id: Option<String>,
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
struct TalkerMessageBody {
    #[serde(rename = "roomId")]
    room_id: Option<String>,
    #[serde(rename = "authorName")]
    author_name: String,
    text: String,
}

async fn init_db(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS stroke_events (
            id BIGSERIAL PRIMARY KEY,
            event_type VARCHAR(50) NOT NULL,
            stroke_id VARCHAR(36) NOT NULL,
            stroke_data JSONB,
            timestamp BIGINT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            min_x DOUBLE PRECISION,
            min_y DOUBLE PRECISION,
            max_x DOUBLE PRECISION,
            max_y DOUBLE PRECISION,
            room_id VARCHAR(64) NOT NULL DEFAULT '1'
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_stroke_events_room_id ON stroke_events(room_id)",
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_stroke_id ON stroke_events(stroke_id)")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_timestamp ON stroke_events(timestamp)")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_event_type ON stroke_events(event_type)")
        .execute(pool)
        .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_stroke_events_room_timestamp ON stroke_events(room_id, timestamp)",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS rooms (
            room_id VARCHAR(64) PRIMARY KEY,
            name VARCHAR(255) NOT NULL DEFAULT 'Room',
            updated_at BIGINT NOT NULL DEFAULT 0
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS tile_events (
            id BIGSERIAL PRIMARY KEY,
            room_id VARCHAR(64) NOT NULL,
            tile_id BIGINT NOT NULL,
            stroke_id VARCHAR(36) NOT NULL,
            event_type VARCHAR(50) NOT NULL,
            payload JSONB,
            ts BIGINT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS talkers (
            id VARCHAR(36) PRIMARY KEY,
            room_id VARCHAR(64) NOT NULL,
            x DOUBLE PRECISION NOT NULL,
            y DOUBLE PRECISION NOT NULL,
            created_at BIGINT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_talkers_room_id ON talkers(room_id)")
        .execute(pool)
        .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS talker_messages (
            id VARCHAR(36) PRIMARY KEY,
            talker_id VARCHAR(36) NOT NULL,
            room_id VARCHAR(64) NOT NULL,
            author_name VARCHAR(255) NOT NULL,
            text TEXT NOT NULL,
            ts BIGINT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_talker_messages_talker_id ON talker_messages(talker_id)")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_talker_messages_room_ts ON talker_messages(room_id, ts)")
        .execute(pool)
        .await?;

    Ok(())
}

async fn post_strokes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let body = to_bytes(request.into_body())
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Failed to read body" })),
            )
        })?;
    let raw: serde_json::Value = serde_json::from_slice(&body).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid JSON" })),
        )
    })?;

    let room_id = raw
        .get("roomId")
        .and_then(|r| r.as_str())
        .unwrap_or(DEFAULT_ROOM)
        .to_string();

    let points: Vec<[f64; 2]> = serde_json::from_value(
        raw.get("points")
            .cloned()
            .ok_or((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "points required" }))))?,
    )
    .map_err(|_| (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "Invalid points" }))))?;
    if points.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "points min 1" })),
        ));
    }

    let tool = raw.get("tool").and_then(|t| t.as_str()).unwrap_or("pen").to_string();
    let color = raw.get("color").and_then(|c| c.as_str()).unwrap_or("#000000").to_string();
    let width = raw.get("width").and_then(|w| w.as_f64()).unwrap_or(2.0);
    let stroke_id = Uuid::new_v4().to_string();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let xs: Vec<f64> = points.iter().map(|p| p[0]).collect();
    let ys: Vec<f64> = points.iter().map(|p| p[1]).collect();
    let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    let stroke_json = serde_json::json!({
        "id": stroke_id,
        "ts": timestamp,
        "tool": tool,
        "color": color,
        "width": width,
        "points": points,
        "authorId": raw.get("authorId")
    });

    sqlx::query(
        r#"
        INSERT INTO stroke_events (event_type, stroke_id, stroke_data, timestamp, min_x, min_y, max_x, max_y, room_id)
        VALUES ('stroke_created', $1, $2, $3, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(&stroke_id)
    .bind(&stroke_json)
    .bind(timestamp)
    .bind(min_x)
    .bind(min_y)
    .bind(max_x)
    .bind(max_y)
    .bind(&room_id)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db insert stroke_events: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let tile_ids = get_tile_ids_for_bbox(min_x, min_y, max_x, max_y);
    for tile_id in tile_ids {
        sqlx::query(
            r#"
            INSERT INTO tile_events (room_id, tile_id, stroke_id, event_type, payload, ts)
            VALUES ($1, $2, $3, 'stroke_created', $4, $5)
            "#,
        )
        .bind(&room_id)
        .bind(tile_id)
        .bind(&stroke_id)
        .bind(&stroke_json)
        .bind(timestamp)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            tracing::error!("db insert tile_events: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Internal server error" })),
            )
        })?;
    }

    let cache_key = format!("{}{}", EVENTS_FULL_CACHE_PREFIX, room_id);
    let _: Result<(), _> = state.redis.lock().await.del(&cache_key).await;

    let event_payload = serde_json::json!({
        "type": "stroke_created",
        "strokeId": stroke_id,
        "stroke": stroke_json,
        "timestamp": timestamp,
        "roomId": room_id
    });
    let _: Result<(), redis::RedisError> = state.redis.lock().await.publish("stroke_events", event_payload.to_string()).await;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "strokeId": stroke_id, "stroke": stroke_json })),
    ))
}

async fn get_strokes_id(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let room_id = params.get("roomId").map(|s| s.as_str()).unwrap_or(DEFAULT_ROOM);

    let row = sqlx::query_as::<_, (serde_json::Value,)>(
        r#"
        SELECT stroke_data FROM stroke_events
        WHERE stroke_id = $1 AND event_type = 'stroke_created' AND room_id = $2
        ORDER BY timestamp DESC LIMIT 1
        "#,
    )
    .bind(&id)
    .bind(room_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let Some((stroke_data,)) = row else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Stroke not found" })),
        ));
    };

    Ok(Json(stroke_data))
}

async fn get_events(
    State(state): State<Arc<AppState>>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    let room_id = q.get("roomId").map(|s| s.as_str()).unwrap_or(DEFAULT_ROOM);
    let since = q
        .get("since")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let limit_param = q.get("limit").and_then(|s| s.parse::<i64>().ok());
    let limit = match limit_param {
        None if since == 0 => 10000,
        None => 100,
        Some(l) if l <= 0 || l > 10000 => 100,
        Some(l) => l,
    };

    if since == 0 {
        let cache_key = format!("{}{}", EVENTS_FULL_CACHE_PREFIX, room_id);
        let cached: Option<String> = state.redis.lock().await.get(&cache_key).await.ok().flatten();
        if let Some(cached) = cached {
            let payload: serde_json::Value = serde_json::from_str(&cached).unwrap_or(serde_json::Value::Null);
            let events = payload.get("events").cloned().unwrap_or_default();
            let events_len = events.as_array().map(|a| a.len()).unwrap_or(0);
            let use_cache = limit >= events_len as i64;
            if use_cache {
                return Ok(send_events_response(&payload));
            }
            if limit < events_len as i64 {
                let mut sliced = payload.clone();
                if let Some(arr) = payload.get("events").and_then(|e| e.as_array()) {
                    let take: Vec<_> = arr.iter().take(limit as usize).cloned().collect();
                    sliced["events"] = serde_json::Value::Array(take);
                }
                return Ok(send_events_response(&sliced));
            }
        }
    }

    let events_rows = sqlx::query_as::<_, (String, String, Option<serde_json::Value>, i64)>(
        r#"
        SELECT event_type, stroke_id, stroke_data, timestamp
        FROM stroke_events
        WHERE room_id = $1 AND timestamp > $2
        ORDER BY timestamp ASC
        LIMIT $3
        "#,
    )
    .bind(room_id)
    .bind(since)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db events: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let name_row = sqlx::query_as::<_, (String,)>(
        "SELECT name FROM rooms WHERE room_id = $1",
    )
    .bind(room_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db room name: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let room_name = name_row
        .map(|(n,)| n)
        .unwrap_or_else(|| format!("Room {}", room_id));

    let events: Vec<serde_json::Value> = events_rows
        .into_iter()
        .map(|(event_type, stroke_id, stroke_data, timestamp)| {
            serde_json::json!({
                "type": event_type,
                "strokeId": stroke_id,
                "stroke": stroke_data,
                "timestamp": timestamp
            })
        })
        .collect();

    let payload = serde_json::json!({
        "events": events,
        "roomId": room_id,
        "roomName": room_name
    });

    if since == 0 {
        let cache_key = format!("{}{}", EVENTS_FULL_CACHE_PREFIX, room_id);
        let _: Result<(), redis::RedisError> = state
            .redis
            .lock()
            .await
            .set_ex(&cache_key, payload.to_string(), EVENTS_FULL_CACHE_TTL_SEC as usize)
            .await;
    }

    Ok(send_events_response(&payload))
}

fn send_events_response(payload: &serde_json::Value) -> axum::response::Response {
    (StatusCode::OK, Json(payload.clone())).into_response()
}

async fn post_strokes_id_erase(
    State(state): State<Arc<AppState>>,
    Path(stroke_id): Path<String>,
    Json(body): Json<EraseBody>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let room_id = body.room_id.as_deref().unwrap_or(DEFAULT_ROOM);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let stroke_data = serde_json::json!({ "hiddenPointIndices": body.hidden_point_indices });

    sqlx::query(
        r#"
        INSERT INTO stroke_events (event_type, stroke_id, stroke_data, timestamp, room_id)
        VALUES ('stroke_erased', $1, $2, $3, $4)
        "#,
    )
    .bind(&stroke_id)
    .bind(&stroke_data)
    .bind(timestamp)
    .bind(room_id)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db erase: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let bbox_row = sqlx::query_as::<_, (Option<f64>, Option<f64>, Option<f64>, Option<f64>)>(
        r#"
        SELECT min_x, min_y, max_x, max_y FROM stroke_events
        WHERE stroke_id = $1 AND event_type = 'stroke_created' AND room_id = $2 AND min_x IS NOT NULL
        LIMIT 1
        "#,
    )
    .bind(&stroke_id)
    .bind(room_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db bbox: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    if let Some((Some(min_x), Some(min_y), Some(max_x), Some(max_y))) = bbox_row {
        let tile_ids = get_tile_ids_for_bbox(min_x, min_y, max_x, max_y);
        let payload = serde_json::json!({ "hiddenPointIndices": body.hidden_point_indices });
        for tile_id in tile_ids {
            sqlx::query(
                r#"
                INSERT INTO tile_events (room_id, tile_id, stroke_id, event_type, payload, ts)
                VALUES ($1, $2, $3, 'stroke_erased', $4, $5)
                "#,
            )
            .bind(room_id)
            .bind(tile_id)
            .bind(&stroke_id)
            .bind(&payload)
            .bind(timestamp)
            .execute(&state.pool)
            .await
            .map_err(|e| {
                tracing::error!("db tile_events erase: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "Internal server error" })),
                )
            })?;
        }
    }

    let cache_key = format!("{}{}", EVENTS_FULL_CACHE_PREFIX, room_id);
    let _: Result<(), _> = state.redis.lock().await.del(&cache_key).await;

    let event_payload = serde_json::json!({
        "type": "stroke_erased",
        "strokeId": stroke_id,
        "timestamp": timestamp,
        "hiddenPointIndices": body.hidden_point_indices,
        "roomId": room_id
    });
    let _: Result<(), redis::RedisError> = state.redis.lock().await.publish("stroke_events", event_payload.to_string()).await;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "strokeId": stroke_id,
            "hiddenPointIndices": body.hidden_point_indices
        })),
    ))
}

async fn get_rooms(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let rooms_rows = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT room_id, name, updated_at FROM rooms ORDER BY updated_at DESC",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db rooms: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let used: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT room_id FROM stroke_events",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db distinct rooms: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let mut by_id: std::collections::HashMap<String, (String, i64)> = rooms_rows
        .into_iter()
        .map(|(room_id, name, updated_at)| (room_id, (name, updated_at)))
        .collect();
    for id in used {
        by_id
            .entry(id.clone())
            .or_insert_with(|| (format!("Room {}", id), 0));
    }
    let rooms: Vec<serde_json::Value> = by_id
        .into_iter()
        .map(|(room_id, (name, updated_at))| {
            serde_json::json!({ "roomId": room_id, "name": name, "updatedAt": updated_at })
        })
        .collect();

    Ok(Json(serde_json::json!({ "rooms": rooms })))
}

async fn get_rooms_rename(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let name = params.get("name").map(|s| s.trim()).unwrap_or("");
    if name.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Query param name is required" })),
        ));
    }
    if name.len() > 255 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Name too long" })),
        ));
    }
    let updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    sqlx::query(
        r#"
        INSERT INTO rooms (room_id, name, updated_at) VALUES ($1, $2, $3)
        ON CONFLICT (room_id) DO UPDATE SET name = $2, updated_at = $3
        "#,
    )
    .bind(&room_id)
    .bind(name)
    .bind(updated_at)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db room rename: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let event_json = serde_json::json!({
        "type": "room_renamed",
        "roomId": room_id,
        "name": name,
        "updatedAt": updated_at
    });
    let _: Result<(), redis::RedisError> = state
        .redis
        .lock()
        .await
        .publish("room_events", event_json.to_string())
        .await;

    Ok(Json(serde_json::json!({
        "roomId": room_id,
        "name": name,
        "updatedAt": updated_at
    })))
}

async fn get_rooms_id(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let row = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT room_id, name, updated_at FROM rooms WHERE room_id = $1",
    )
    .bind(&room_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db room: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let (room_id, name, updated_at) = row.unwrap_or((
        room_id.clone(),
        format!("Room {}", room_id),
        0i64,
    ));

    Ok(Json(serde_json::json!({
        "roomId": room_id,
        "name": name,
        "updatedAt": updated_at
    })))
}

async fn put_rooms_id(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    Json(body): Json<RoomNameBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid name" })),
        ));
    }
    let updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    sqlx::query(
        r#"
        INSERT INTO rooms (room_id, name, updated_at) VALUES ($1, $2, $3)
        ON CONFLICT (room_id) DO UPDATE SET name = $2, updated_at = $3
        "#,
    )
    .bind(&room_id)
    .bind(name)
    .bind(updated_at)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db room put: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let event_json = serde_json::json!({
        "type": "room_renamed",
        "roomId": room_id,
        "name": name,
        "updatedAt": updated_at
    });
    let _: Result<(), redis::RedisError> = state
        .redis
        .lock()
        .await
        .publish("room_events", event_json.to_string())
        .await;

    Ok(Json(serde_json::json!({
        "roomId": room_id,
        "name": name,
        "updatedAt": updated_at
    })))
}

async fn get_talkers(
    State(state): State<Arc<AppState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let room_id = params.get("roomId").map(|s| s.as_str()).unwrap_or(DEFAULT_ROOM);

    let rows = sqlx::query_as::<_, (String, String, f64, f64, i64)>(
        "SELECT id, room_id, x, y, created_at FROM talkers WHERE room_id = $1 ORDER BY created_at ASC",
    )
    .bind(room_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db talkers: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let talkers: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, room_id, x, y, created_at)| {
            serde_json::json!({
                "id": id,
                "roomId": room_id,
                "x": x,
                "y": y,
                "createdAt": created_at
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "talkers": talkers })))
}

async fn post_talkers(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TalkerCreateBody>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let room_id = body.room_id.as_deref().unwrap_or(DEFAULT_ROOM);
    let id = Uuid::new_v4().to_string();
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    sqlx::query(
        "INSERT INTO talkers (id, room_id, x, y, created_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&id)
    .bind(room_id)
    .bind(body.x)
    .bind(body.y)
    .bind(created_at)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db talker create: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let talker = serde_json::json!({
        "id": id,
        "roomId": room_id,
        "x": body.x,
        "y": body.y,
        "createdAt": created_at
    });
    let event_json = serde_json::json!({ "type": "talker_created", "roomId": room_id, "talker": talker });
    let _: Result<(), redis::RedisError> = state
        .redis
        .lock()
        .await
        .publish("talker_events", event_json.to_string())
        .await;

    Ok((
        StatusCode::CREATED,
        Json(talker),
    ))
}

async fn get_talkers_id_messages(
    State(state): State<Arc<AppState>>,
    Path(talker_id): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let room_id = params.get("roomId").map(|s| s.as_str()).unwrap_or(DEFAULT_ROOM);
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(100)
        .clamp(1, 500);

    let rows = sqlx::query_as::<_, (String, String, String, String, String, i64)>(
        r#"
        SELECT id, talker_id, room_id, author_name, text, ts
        FROM talker_messages
        WHERE talker_id = $1 AND room_id = $2
        ORDER BY ts ASC
        LIMIT $3
        "#,
    )
    .bind(&talker_id)
    .bind(room_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db talker messages: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let messages: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, talker_id, room_id, author_name, text, ts)| {
            serde_json::json!({
                "id": id,
                "talkerId": talker_id,
                "roomId": room_id,
                "authorName": author_name,
                "text": text,
                "ts": ts
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "messages": messages })))
}

async fn post_talkers_id_messages(
    State(state): State<Arc<AppState>>,
    Path(talker_id): Path<String>,
    Json(body): Json<TalkerMessageBody>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let room_id = body.room_id.as_deref().unwrap_or(DEFAULT_ROOM);
    if body.author_name.is_empty() || body.author_name.len() > 255 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid authorName" })),
        ));
    }
    if body.text.len() > 10000 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "text too long" })),
        ));
    }
    let id = Uuid::new_v4().to_string();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    sqlx::query(
        r#"
        INSERT INTO talker_messages (id, talker_id, room_id, author_name, text, ts)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(&id)
    .bind(&talker_id)
    .bind(room_id)
    .bind(&body.author_name)
    .bind(&body.text)
    .bind(ts)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("db talker message: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
    })?;

    let message = serde_json::json!({
        "id": id,
        "talkerId": talker_id,
        "roomId": room_id,
        "authorName": body.author_name,
        "text": body.text,
        "ts": ts
    });
    let event_json = serde_json::json!({ "type": "talker_message", "roomId": room_id, "message": message });
    let _: Result<(), redis::RedisError> = state
        .redis
        .lock()
        .await
        .publish("talker_events", event_json.to_string())
        .await;

    Ok((StatusCode::CREATED, Json(message)))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("event_store=info".parse()?))
        .init();

    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgresql://infidraw:infidraw_dev@localhost:5432/infidraw".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&database_url)
        .await?;
    init_db(&pool).await?;

    let redis_client = redis::Client::open(redis_url)?;
    let redis_manager = redis_client.get_tokio_connection_manager().await?;
    let state = Arc::new(AppState {
        pool,
        redis: Arc::new(tokio::sync::Mutex::new(redis_manager)),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/strokes", post(post_strokes))
        .route("/strokes/:id", get(get_strokes_id))
        .route("/strokes/:id/erase", post(post_strokes_id_erase))
        .route("/events", get(get_events))
        .route("/rooms", get(get_rooms))
        .route("/rooms/:room_id/rename", get(get_rooms_rename))
        .route("/rooms/:room_id", get(get_rooms_id).put(put_rooms_id).post(put_rooms_id))
        .route("/talkers", get(get_talkers).post(post_talkers))
        .route("/talkers/:id/messages", get(get_talkers_id_messages).post(post_talkers_id_messages))
        .with_state(state);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Event Store (Rust) running on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn it_works() {
        assert!(true);
    }
}
