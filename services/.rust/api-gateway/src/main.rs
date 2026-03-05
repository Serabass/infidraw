//! API Gateway: rate limit (Redis) + proxy to event-store, tile-service, metrics-service.
//! Same behaviour as services/api-gateway (Express).

use axum::{
    body::Body,
    extract::State,
    http::{header, Request, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use std::sync::Arc;
use std::time::Duration;
use axum::body::to_bytes;
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

const RATE_LIMIT_WINDOW_SEC: u64 = 60;
const RATE_LIMIT_MAX: i64 = 100;

#[derive(Clone)]
struct AppState {
    redis: Arc<tokio::sync::Mutex<redis::aio::ConnectionManager>>,
    event_store_url: String,
    tile_service_url: String,
    metrics_service_url: String,
    client: reqwest::Client,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("api_gateway=info".parse()?))
        .init();

    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into());
    let redis_client = redis::Client::open(redis_url)?;
    let redis = redis::aio::ConnectionManager::new(redis_client).await?;

    let event_store_url = std::env::var("EVENT_STORE_URL").unwrap_or_else(|_| "http://event-store:3000".into());
    let tile_service_url = std::env::var("TILE_SERVICE_URL").unwrap_or_else(|_| "http://tile-service:3000".into());
    let metrics_service_url =
        std::env::var("METRICS_SERVICE_URL").unwrap_or_else(|_| "http://metrics-service:3000".into());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

    let state = AppState {
        redis: Arc::new(tokio::sync::Mutex::new(redis)),
        event_store_url: event_store_url.trim_end_matches('/').to_string(),
        tile_service_url: tile_service_url.trim_end_matches('/').to_string(),
        metrics_service_url: metrics_service_url.trim_end_matches('/').to_string(),
        client,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/strokes", axum::routing::any(proxy_api))
        .route("/api/strokes/*rest", axum::routing::any(proxy_api))
        .route("/api/events", axum::routing::any(proxy_api))
        .route("/api/events/*rest", axum::routing::any(proxy_api))
        .route("/api/rooms", axum::routing::any(proxy_api))
        .route("/api/rooms/*rest", axum::routing::any(proxy_api))
        .route("/api/tiles", axum::routing::any(proxy_api))
        .route("/api/tiles/*rest", axum::routing::any(proxy_api))
        .route("/api/talkers", axum::routing::any(proxy_api))
        .route("/api/talkers/*rest", axum::routing::any(proxy_api))
        .route("/api/metrics", axum::routing::any(proxy_api))
        .route("/api/metrics/*rest", axum::routing::any(proxy_api))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("API Gateway listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "status": "ok",
        "services": ["event-store", "tile-service", "realtime-service", "metrics-service"]
    }))
}

fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

async fn rate_limit_check(state: &AppState, key: &str) -> Result<(), StatusCode> {
    let mut conn = state.redis.lock().await;
    let redis_key = format!("rl:{}", key);
    let count: i64 = redis::cmd("INCR")
        .arg(&redis_key)
        .query_async(&mut *conn)
        .await
        .map_err(|e| {
            tracing::warn!("Redis INCR failed: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    if count == 1 {
        let _: Result<(), redis::RedisError> =
            redis::cmd("EXPIRE").arg(&redis_key).arg(RATE_LIMIT_WINDOW_SEC as i64).query_async(&mut *conn).await;
    }
    if count > RATE_LIMIT_MAX {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    Ok(())
}

fn upstream_url(state: &AppState, path: &str) -> Option<String> {
    let path_after_api = path.strip_prefix("/api")?.trim_start_matches('/');
    let (base, path_rewrite) = if path_after_api.starts_with("strokes") {
        (state.event_store_url.as_str(), path_after_api)
    } else if path_after_api.starts_with("events") {
        (state.event_store_url.as_str(), path_after_api)
    } else if path_after_api.starts_with("rooms") {
        (state.event_store_url.as_str(), path_after_api)
    } else if path_after_api.starts_with("talkers") {
        (state.event_store_url.as_str(), path_after_api)
    } else if path_after_api.starts_with("tiles") {
        (state.tile_service_url.as_str(), path_after_api)
    } else if path_after_api.starts_with("metrics") {
        (state.metrics_service_url.as_str(), path_after_api)
    } else {
        return None;
    };
    Some(format!("{}/{}", base, path_rewrite))
}

async fn proxy_api(State(state): State<AppState>, request: Request<Body>) -> impl IntoResponse {
    let path = request.uri().path().to_string();
    let ip = client_ip(request.headers());
    if let Err(code) = rate_limit_check(&state, &ip).await {
        return (code, "Rate limit exceeded").into_response();
    }
    let Some(target_url) = upstream_url(&state, &path) else {
        return (StatusCode::NOT_FOUND, "Unknown API path").into_response();
    };
    let query = request.uri().query().unwrap_or("");
    let full_url = if query.is_empty() {
        target_url
    } else {
        format!("{}?{}", target_url, query)
    };
    let method = request.method().clone();
    let reqwest_method = reqwest::Method::try_from(method.as_str()).unwrap_or(reqwest::Method::GET);
    let mut out_req = state.client.request(reqwest_method, &full_url);
    for (name, value) in request.headers() {
        if name == header::HOST
            || name == header::CONNECTION
            || name.as_str().to_lowercase().starts_with("transfer-encoding")
        {
            continue;
        }
        if let Ok(v) = value.to_str() {
            out_req = out_req.header(name.as_str(), v);
        }
    }
    let body = request.into_body();
    let body_bytes = match to_bytes(body, 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("Body read error: {}", e);
            return (StatusCode::BAD_REQUEST, "Body error").into_response();
        }
    };
    if !body_bytes.is_empty() {
        out_req = out_req.body(body_bytes.to_vec());
    }
    let resp = match out_req.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("Upstream request failed: {}", e);
            return (StatusCode::BAD_GATEWAY, "Upstream error").into_response();
        }
    };
    let status = resp.status();
    let headers = resp.headers().clone();
    let body = resp.bytes().await.unwrap_or_default();
    let axum_status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = (axum_status, body).into_response();
    for (k, v) in headers {
        if let Some(name) = k {
            if let (Ok(axum_name), Ok(axum_value)) = (
                axum::http::header::HeaderName::try_from(name.as_str()),
                axum::http::HeaderValue::try_from(v.as_bytes()),
            ) {
                response.headers_mut().insert(axum_name, axum_value);
            }
        }
    }
    response
}

#[cfg(test)]
mod tests {
    #[test]
    fn it_works() {
        assert!(true);
    }
}
