//! Snapshot-worker: POST /render (strokes -> PNG), GET /health. Parity with Go version.

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use image::{ImageBuffer, RgbImage};
use imageproc::drawing::draw_antialiased_line_segment_mut;
use imageproc::pixelops::interpolate;
use serde::Deserialize;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

const DEFAULT_TILE_SIZE: u32 = 512;

#[derive(Deserialize)]
struct Stroke {
    id: Option<String>,
    ts: Option<f64>,
    tool: Option<String>,
    color: Option<String>,
    width: Option<f64>,
    points: Vec<[f64; 2]>,
    #[serde(rename = "authorId")]
    author_id: Option<String>,
    hidden: Option<bool>,
}

#[derive(Deserialize)]
struct RenderRequest {
    tile_x: Option<i32>,
    #[serde(rename = "tileX")]
    tile_x_alt: Option<i32>,
    tile_y: Option<i32>,
    #[serde(rename = "tileY")]
    tile_y_alt: Option<i32>,
    #[serde(rename = "tileSize")]
    tile_size: Option<u32>,
    strokes: Vec<Stroke>,
}

fn tile_x(req: &RenderRequest) -> i32 {
    req.tile_x.or(req.tile_x_alt).unwrap_or(0)
}
fn tile_y(req: &RenderRequest) -> i32 {
    req.tile_y.or(req.tile_y_alt).unwrap_or(0)
}
fn tile_size(req: &RenderRequest) -> u32 {
    req.tile_size.filter(|&s| s > 0).unwrap_or(DEFAULT_TILE_SIZE)
}

fn parse_hex_color(hex: &str) -> [u8; 3] {
    let hex = hex.trim_start_matches('#');
    if hex.len() >= 6 {
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(0);
        let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
        return [r, g, b];
    }
    [0, 0, 0]
}

/// Draw a line segment with given pixel width (parity with Go/Node: SetLineWidth + Stroke).
fn draw_thick_line_mut(
    img: &mut RgbImage,
    start: (i32, i32),
    end: (i32, i32),
    color: image::Rgb<u8>,
    width_px: f64,
) {
    let (x0, y0) = start;
    let (x1, y1) = end;
    let dx = (x1 - x0) as f64;
    let dy = (y1 - y0) as f64;
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-6 {
        return;
    }
    let ux = dx / len;
    let uy = dy / len;
    let perp_x = -uy;
    let perp_y = ux;
    let half = (width_px * 0.5).max(0.0) as i32;
    for offset in -half..=half {
        let ox = (perp_x * offset as f64).round() as i32;
        let oy = (perp_y * offset as f64).round() as i32;
        let s = (x0 + ox, y0 + oy);
        let e = (x1 + ox, y1 + oy);
        draw_antialiased_line_segment_mut(img, s, e, color, interpolate);
    }
}

fn render_tile(
    tile_x: i32,
    tile_y: i32,
    tile_size: u32,
    strokes: &[Stroke],
) -> Result<Vec<u8>, image::ImageError> {
    let mut img: RgbImage = ImageBuffer::from_pixel(tile_size, tile_size, image::Rgb([255, 255, 255]));
    let x1 = (tile_x as f64) * (tile_size as f64);
    let y1 = (tile_y as f64) * (tile_size as f64);

    for s in strokes {
        if s.hidden.unwrap_or(false) || s.points.len() < 2 {
            continue;
        }
        let width = s.width.unwrap_or(2.0).max(0.5);
        let (r, g, b) = if s.tool.as_deref() == Some("eraser") {
            (255u8, 255, 255)
        } else {
            let c = parse_hex_color(s.color.as_deref().unwrap_or("#000000"));
            (c[0], c[1], c[2])
        };
        let color = image::Rgb([r, g, b]);

        for i in 0..s.points.len() - 1 {
            let [px0, py0] = s.points[i];
            let [px1, py1] = s.points[i + 1];
            let start = ((px0 - x1).round() as i32, (py0 - y1).round() as i32);
            let end = ((px1 - x1).round() as i32, (py1 - y1).round() as i32);
            draw_thick_line_mut(&mut img, start, end, color, width);
        }
    }

    let mut buf = Vec::new();
    let dynamic = image::DynamicImage::ImageRgb8(img);
    dynamic
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)?;
    Ok(buf)
}

async fn handle_render(
    State(_): State<Arc<()>>,
    Json(req): Json<RenderRequest>,
) -> Result<impl IntoResponse, (StatusCode, &'static str)> {
    let tx = tile_x(&req);
    let ty = tile_y(&req);
    let size = tile_size(&req);
    let png = render_tile(tx, ty, size, &req.strokes)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "render failed"))?;
    Ok(([(axum::http::header::CONTENT_TYPE, "image/png")], png))
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "snapshot-worker"
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("snapshot_worker=info".parse()?))
        .init();

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let state = Arc::new(());
    let app = Router::new()
        .route("/render", post(handle_render))
        .route("/health", get(health))
        .with_state(state);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Snapshot worker (Rust) listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
