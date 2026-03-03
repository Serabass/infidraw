//! Realtime service: HTTP /health + WebSocket /ws, Redis pub/sub (stroke_events, room_events, talker_events).
//! Same behaviour as services/realtime-service (Express + ws).

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tracing_subscriber::EnvFilter;

static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct AppState {
    clients: Arc<RwLock<HashMap<u64, String>>>,
    broadcast_tx: broadcast::Sender<(String, String)>,
}

#[derive(serde::Deserialize)]
struct WsQuery {
    #[serde(rename = "roomId")]
    room_id: Option<String>,
}

#[derive(serde::Deserialize)]
struct ClientMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(rename = "roomId")]
    room_id: Option<String>,
    tiles: Option<Vec<String>>,
    stroke: Option<serde_json::Value>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("realtime_service=info".parse()?))
        .init();

    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into());
    let (broadcast_tx, _) = broadcast::channel::<(String, String)>(256);
    let state = AppState {
        clients: Arc::new(RwLock::new(HashMap::new())),
        broadcast_tx: broadcast_tx.clone(),
    };

    redis_subscriber_thread(redis_url, broadcast_tx);

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_handler))
        .with_state(state);

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Realtime Service (HTTP+WS) on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let n = state.clients.read().await.len();
    axum::Json(serde_json::json!({ "status": "ok", "clients": n }))
}

async fn ws_handler(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
) -> impl IntoResponse {
    let room_id = q.room_id.unwrap_or_else(|| "1".to_string());
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    ws.on_upgrade(move |socket| handle_socket(state, socket, room_id, client_id))
}

async fn handle_socket(
    state: AppState,
    socket: WebSocket,
    room_id: String,
    client_id: u64,
) {
    let (mut sender, mut receiver) = socket.split();
    state
        .clients
        .write()
        .await
        .insert(client_id, room_id.clone());
    tracing::info!(
        "WS client connected, id={}, room={}, total={}",
        client_id,
        room_id,
        state.clients.read().await.len()
    );

    let mut broadcast_rx = state.broadcast_tx.subscribe();
    let send_task = tokio::spawn(async move {
        while let Ok((msg_room, payload)) = broadcast_rx.recv().await {
            if msg_room == room_id {
                if sender.send(Message::Text(payload)).await.is_err() {
                    break;
                }
            }
        }
    });

    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(m) = serde_json::from_str::<ClientMessage>(&text) {
                if m.msg_type == "subscribe" {
                    if let Some(rid) = m.room_id {
                        state.clients.write().await.insert(client_id, rid.clone());
                    }
                } else if m.msg_type == "stroke_created" {
                    if let (Some(rid), Some(stroke)) = (m.room_id.as_ref(), m.stroke.as_ref()) {
                        let payload =
                            serde_json::json!({ "type": "stroke_created", "stroke": stroke, "roomId": rid });
                        let _ = state.broadcast_tx.send((rid.clone(), payload.to_string()));
                    }
                }
            }
        }
    }

    send_task.abort();
    state.clients.write().await.remove(&client_id);
    tracing::info!("WS client disconnected, id={}", client_id);
}

fn redis_subscriber_thread(redis_url: String, tx: broadcast::Sender<(String, String)>) {
    let (std_tx, std_rx) = std::sync::mpsc::sync_channel::<(String, String)>(1024);
    let tx_clone = tx.clone();
    std::thread::spawn(move || {
        while let Ok((room_id, payload)) = std_rx.recv() {
            let _ = tx_clone.send((room_id, payload));
        }
    });
    std::thread::spawn(move || {
        let client = match redis::Client::open(redis_url.as_str()) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("Redis client: {}", e);
                return;
            }
        };
        let mut conn = match client.get_connection() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("Redis connect: {}", e);
                return;
            }
        };
        let mut pubsub = conn.as_pubsub();
        if pubsub.subscribe("stroke_events").is_err()
            || pubsub.subscribe("room_events").is_err()
            || pubsub.subscribe("talker_events").is_err()
        {
            tracing::error!("Redis subscribe failed");
            return;
        }
        tracing::info!("Redis subscribed to stroke_events, room_events, talker_events");
        loop {
            let msg = match pubsub.get_message() {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Redis get_message: {}", e);
                    break;
                }
            };
            let payload: String = match msg.get_payload() {
                Ok(s) => s,
                Err(_) => continue,
            };
            let room_id = extract_room_from_payload(&payload).unwrap_or_else(|| "1".to_string());
            if std_tx.send((room_id, payload)).is_err() {
                break;
            }
        }
    });
}

fn extract_room_from_payload(payload: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    v.get("roomId")
        .or(v.get("room_id"))
        .and_then(|r| r.as_str())
        .map(String::from)
}
