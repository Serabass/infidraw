import express from 'express';
import { Pool } from 'pg';
import { createClient } from 'redis';
import * as Minio from 'minio';
import { createCanvas } from 'canvas';
import type { Stroke, TileResponse } from './types';

const app = express();
app.use(express.json());

const TILE_SIZE = parseInt(process.env.TILE_SIZE || '512');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT!.split(':')[0],
  port: parseInt(process.env.MINIO_ENDPOINT!.split(':')[1] || '9000'),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'tile-snapshots';

function getTileCoords(worldX: number, worldY: number): [number, number] {
  return [Math.floor(worldX / TILE_SIZE), Math.floor(worldY / TILE_SIZE)];
}

function getTileBbox(tileX: number, tileY: number): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: tileX * TILE_SIZE,
    y1: tileY * TILE_SIZE,
    x2: (tileX + 1) * TILE_SIZE,
    y2: (tileY + 1) * TILE_SIZE,
  };
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tile_snapshots (
      tile_x INTEGER NOT NULL,
      tile_y INTEGER NOT NULL,
      version BIGINT NOT NULL,
      snapshot_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (tile_x, tile_y, version)
    );
    
    CREATE INDEX IF NOT EXISTS idx_tile_coords ON tile_snapshots(tile_x, tile_y);
  `);
}

async function initMinio() {
  const exists = await minioClient.bucketExists(BUCKET_NAME);
  if (!exists) {
    await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
  }
}

async function initRedis() {
  await redisClient.connect();
}

async function getStrokesForTile(tileX: number, tileY: number, sinceVersion?: number): Promise<Stroke[]> {
  const bbox = getTileBbox(tileX, tileY);
  
  const query = `
    SELECT stroke_data 
    FROM stroke_events 
    WHERE event_type = 'stroke_created' 
      AND stroke_data->>'hidden' IS DISTINCT FROM 'true'
      AND (
        (stroke_data->'points'->0->>0)::float BETWEEN $1 AND $2
        OR (stroke_data->'points'->0->>1)::float BETWEEN $3 AND $4
      )
    ORDER BY timestamp ASC
  `;

  const result = await pool.query(query, [bbox.x1, bbox.x2, bbox.y1, bbox.y2]);
  
  return result.rows
    .map((row) => row.stroke_data as Stroke)
    .filter((stroke) => {
      return stroke.points.some(
        ([x, y]) => x >= bbox.x1 && x < bbox.x2 && y >= bbox.y1 && y < bbox.y2
      );
    });
}

function getBrushStyle(tool: string) {
  switch (tool) {
    case 'pen':
      return { opacity: 1, lineCap: 'round' as CanvasLineCap, lineJoin: 'round' as CanvasLineJoin, dash: [] };
    case 'brush':
      return { opacity: 0.8, lineCap: 'round' as CanvasLineCap, lineJoin: 'round' as CanvasLineJoin, dash: [] };
    case 'marker':
      return { opacity: 0.7, lineCap: 'square' as CanvasLineCap, lineJoin: 'miter' as CanvasLineJoin, dash: [] };
    case 'highlighter':
      return { opacity: 0.4, lineCap: 'round' as CanvasLineCap, lineJoin: 'round' as CanvasLineJoin, dash: [] };
    case 'pencil':
      return { opacity: 0.9, lineCap: 'round' as CanvasLineCap, lineJoin: 'round' as CanvasLineJoin, dash: [] };
    case 'chalk':
      return { opacity: 0.85, lineCap: 'round' as CanvasLineCap, lineJoin: 'round' as CanvasLineJoin, dash: [5, 5] };
    case 'eraser':
      return { opacity: 1, lineCap: 'round' as CanvasLineCap, lineJoin: 'round' as CanvasLineJoin, dash: [] };
    default:
      return { opacity: 1, lineCap: 'round' as CanvasLineCap, lineJoin: 'round' as CanvasLineJoin, dash: [] };
  }
}

async function renderTileSnapshot(tileX: number, tileY: number, strokes: Stroke[]): Promise<Buffer> {
  const canvas = createCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

  for (const stroke of strokes) {
    if (stroke.hidden) continue;

    const style = getBrushStyle(stroke.tool);
    const strokeColor = stroke.tool === 'eraser' ? '#ffffff' : stroke.color;
    
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = style.lineCap;
    ctx.lineJoin = style.lineJoin;
    ctx.globalAlpha = style.opacity;
    
    if (style.dash.length > 0) {
      ctx.setLineDash(style.dash);
    } else {
      ctx.setLineDash([]);
    }

    // Для ластика используем composite operation
    if (stroke.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
    } else {
      ctx.globalCompositeOperation = 'source-over';
    }

    const bbox = getTileBbox(tileX, tileY);
    ctx.beginPath();

    for (let i = 0; i < stroke.points.length; i++) {
      const [x, y] = stroke.points[i];
      const localX = x - bbox.x1;
      const localY = y - bbox.y1;

      if (i === 0) {
        ctx.moveTo(localX, localY);
      } else {
        ctx.lineTo(localX, localY);
      }
    }

    ctx.stroke();
  }

  // Восстанавливаем значения по умолчанию
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.setLineDash([]);

  return canvas.toBuffer('image/png');
}

// GET /tiles - получить тайлы для области
app.get('/tiles', async (req, res) => {
  try {
    const x1 = parseFloat(req.query.x1 as string);
    const y1 = parseFloat(req.query.y1 as string);
    const x2 = parseFloat(req.query.x2 as string);
    const y2 = parseFloat(req.query.y2 as string);
    const sinceVersion = req.query.sinceVersion ? parseInt(req.query.sinceVersion as string) : undefined;

    if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const [minTileX, minTileY] = getTileCoords(x1, y1);
    const [maxTileX, maxTileY] = getTileCoords(x2, y2);

    const tiles: TileResponse[] = [];

    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
      for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
        const strokes = await getStrokesForTile(tileX, tileY, sinceVersion);
        
        // Проверяем, есть ли уже снапшот для этого тайла
        let snapshotUrl: string | undefined;
        const latestSnapshot = await pool.query(
          `SELECT snapshot_url, version FROM tile_snapshots 
           WHERE tile_x = $1 AND tile_y = $2 
           ORDER BY version DESC LIMIT 1`,
          [tileX, tileY]
        );

        // Проверяем, нужно ли обновить снапшот
        // Если есть снапшот и sinceVersion не указан или совпадает, используем существующий
        if (latestSnapshot.rows.length > 0 && (!sinceVersion || parseInt(latestSnapshot.rows[0].version) >= sinceVersion)) {
          snapshotUrl = latestSnapshot.rows[0].snapshot_url;
        } else if (strokes.length > 0) {
          // Создаем новый снапшот только если его нет или нужна новая версия
          const version = Date.now();
          const snapshotKey = `tile_${tileX}_${tileY}_${version}.png`;
          
          const snapshotBuffer = await renderTileSnapshot(tileX, tileY, strokes);
          await minioClient.putObject(BUCKET_NAME, snapshotKey, snapshotBuffer, snapshotBuffer.length, {
            'Content-Type': 'image/png',
          });
          
          snapshotUrl = `/snapshots/${snapshotKey}`;
          
          // Сохраняем информацию о снапшоте в БД
          await pool.query(
            `INSERT INTO tile_snapshots (tile_x, tile_y, version, snapshot_url) 
             VALUES ($1, $2, $3, $4)`,
            [tileX, tileY, version, snapshotUrl]
          );
        }

        const version = latestSnapshot.rows.length > 0 
          ? parseInt(latestSnapshot.rows[0].version) 
          : Date.now();

        tiles.push({
          tileX,
          tileY,
          version,
          snapshotUrl,
          strokes,
        });
      }
    }

    res.json({ tiles });
  } catch (error) {
    console.error('Error fetching tiles:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /snapshots/:key - отдать снапшот напрямую из MinIO
app.get('/snapshots/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const object = await minioClient.getObject(BUCKET_NAME, key);
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    object.pipe(res);
  } catch (error: any) {
    if (error.code === 'NoSuchKey') {
      res.status(404).json({ error: 'Snapshot not found' });
    } else {
      console.error('Error fetching snapshot:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initDb();
    await initMinio();
    await initRedis();
    app.listen(PORT, () => {
      console.log(`Tile Service running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start service:', error);
    process.exit(1);
  }
}

start();
