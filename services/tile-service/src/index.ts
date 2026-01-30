import express from 'express';
import { Pool } from 'pg';
import { createClient } from 'redis';
import * as Minio from 'minio';
import { createCanvas } from 'canvas';
import type { Stroke, TileResponse } from './types';

const app = express();
app.use(express.json({ limit: '10mb' }));

const TILE_SIZE = parseInt(process.env.TILE_SIZE || '512');
const TILE_ID_OFFSET = 500_000;

function encodeTileId(tileX: number, tileY: number): number {
  return (tileX + TILE_ID_OFFSET) * 1_000_000 + (tileY + TILE_ID_OFFSET);
}

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

const DEFAULT_ROOM = '1';

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tile_snapshots (
      room_id VARCHAR(64) NOT NULL DEFAULT '1',
      tile_x INTEGER NOT NULL,
      tile_y INTEGER NOT NULL,
      version BIGINT NOT NULL,
      snapshot_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (room_id, tile_x, tile_y, version)
    );
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tile_snapshots' AND column_name = 'room_id') THEN
        ALTER TABLE tile_snapshots ADD COLUMN room_id VARCHAR(64) NOT NULL DEFAULT '1';
        ALTER TABLE tile_snapshots DROP CONSTRAINT IF EXISTS tile_snapshots_pkey;
        ALTER TABLE tile_snapshots ADD PRIMARY KEY (room_id, tile_x, tile_y, version);
      END IF;
    END $$;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tile_coords ON tile_snapshots(room_id, tile_x, tile_y);
    
    DO $$ 
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                     WHERE table_name = 'stroke_events' AND column_name = 'min_x') THEN
        ALTER TABLE stroke_events 
          ADD COLUMN min_x DOUBLE PRECISION,
          ADD COLUMN min_y DOUBLE PRECISION,
          ADD COLUMN max_x DOUBLE PRECISION,
          ADD COLUMN max_y DOUBLE PRECISION;
      END IF;
    END $$;
    
    CREATE INDEX IF NOT EXISTS idx_stroke_coords ON stroke_events(min_x, min_y, max_x, max_y) 
      WHERE event_type = 'stroke_created' AND min_x IS NOT NULL;
    
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stroke_events' AND column_name = 'room_id') THEN
        ALTER TABLE stroke_events ADD COLUMN room_id VARCHAR(64) NOT NULL DEFAULT '1';
      END IF;
    END $$;
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

/** Build strokes from tile_events (stroke_created + stroke_erased). Returns map stroke_id -> { stroke, lastTs }. */
function applyTileEvents(rows: { event_type: string; stroke_id: string; payload: unknown; ts: number }[]): { strokes: Stroke[]; lastTsByStroke: Map<string, number> } {
  const strokesById = new Map<string, Stroke>();
  const lastTsByStroke = new Map<string, number>();
  for (const row of rows) {
    const ts = Number(row.ts);
    lastTsByStroke.set(row.stroke_id, ts);
    if (row.event_type === 'stroke_created') {
      const stroke = row.payload as Stroke;
      if (!stroke.hidden) strokesById.set(row.stroke_id, { ...stroke });
    } else if (row.event_type === 'stroke_erased') {
      const stroke = strokesById.get(row.stroke_id);
      if (stroke && (row.payload as { hiddenPointIndices?: number[] }).hiddenPointIndices) {
        const indices = new Set((row.payload as { hiddenPointIndices: number[] }).hiddenPointIndices);
        stroke.points = stroke.points.filter((_, i) => !indices.has(i));
        if (stroke.points.length === 0) strokesById.delete(row.stroke_id);
      }
    }
  }
  return { strokes: Array.from(strokesById.values()), lastTsByStroke };
}

async function getStrokesForTile(tileX: number, tileY: number, roomId: string, sinceVersion?: number): Promise<Stroke[]> {
  const rid = roomId || DEFAULT_ROOM;
  const tileId = encodeTileId(tileX, tileY);
  const startTime = Date.now();

  const tileEventsQuery = `
    SELECT id, event_type, stroke_id, payload, ts
    FROM tile_events
    WHERE room_id = $1 AND tile_id = $2
    ORDER BY id ASC
    LIMIT 50000
  `;
  const tileResult = await pool.query(tileEventsQuery, [rid, tileId]);

  if (tileResult.rows.length > 0) {
    const { strokes, lastTsByStroke } = applyTileEvents(tileResult.rows);
    const bbox = getTileBbox(tileX, tileY);
    let filtered = strokes.filter((s) =>
      s.points.some(([x, y]) => x >= bbox.x1 && x < bbox.x2 && y >= bbox.y1 && y < bbox.y2)
    );
    if (sinceVersion != null) {
      filtered = filtered.filter((s) => (lastTsByStroke.get(s.id) ?? 0) > sinceVersion);
    }
    console.log(`[TileService] Tile [${tileX},${tileY}] (tile_id): ${filtered.length} strokes from ${tileResult.rows.length} events (${Date.now() - startTime}ms)`);
    return filtered;
  }

  const bbox = getTileBbox(tileX, tileY);
  const query = `
    SELECT stroke_data, timestamp
    FROM stroke_events 
    WHERE room_id = $1 AND event_type = 'stroke_created' 
      AND stroke_data->>'hidden' IS DISTINCT FROM 'true'
      AND min_x IS NOT NULL
      AND max_x IS NOT NULL
      AND min_y IS NOT NULL
      AND max_y IS NOT NULL
      AND NOT (max_x < $2 OR min_x >= $3 OR max_y < $4 OR min_y >= $5)
      ${sinceVersion ? 'AND timestamp > $6' : ''}
    ORDER BY timestamp DESC
    LIMIT 10000
  `;
  const params = sinceVersion ? [rid, bbox.x1, bbox.x2, bbox.y1, bbox.y2, sinceVersion] : [rid, bbox.x1, bbox.x2, bbox.y1, bbox.y2];
  const result = await pool.query(query, params);
  const strokes = result.rows
    .map((row) => row.stroke_data as Stroke)
    .filter((s) => s.points.some(([x, y]) => x >= bbox.x1 && x < bbox.x2 && y >= bbox.y1 && y < bbox.y2));
  console.log(`[TileService] Tile [${tileX},${tileY}] (bbox fallback): ${strokes.length} strokes (${Date.now() - startTime}ms)`);
  return strokes;
}

type TileEventRow = { event_type: string; stroke_id: string; payload: unknown; ts: number };

/** One query for many tiles: tile_id IN (...). Returns map tile_id -> rows (for delta/snapshot). */
async function getTileEventsBatch(roomId: string, tileIds: number[]): Promise<Map<number, TileEventRow[]>> {
  if (tileIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT tile_id, event_type, stroke_id, payload, ts
     FROM tile_events
     WHERE room_id = $1 AND tile_id = ANY($2::bigint[])
     ORDER BY tile_id, id ASC
     LIMIT 500000`,
    [roomId || DEFAULT_ROOM, tileIds]
  );
  const byTile = new Map<number, TileEventRow[]>();
  for (const row of result.rows) {
    const tileId = Number(row.tile_id);
    if (!byTile.has(tileId)) byTile.set(tileId, []);
    byTile.get(tileId)!.push({
      event_type: row.event_type,
      stroke_id: row.stroke_id,
      payload: row.payload,
      ts: row.ts,
    });
  }
  return byTile;
}

/** Same as getStrokesForTile but uses pre-fetched rows when provided (avoids N queries). */
async function getStrokesForTileWithEvents(
  tileX: number,
  tileY: number,
  roomId: string,
  sinceVersion: number | undefined,
  preFetchedRows: TileEventRow[] | undefined
): Promise<Stroke[]> {
  const rid = roomId || DEFAULT_ROOM;
  const tileId = encodeTileId(tileX, tileY);
  const bbox = getTileBbox(tileX, tileY);

  if (preFetchedRows && preFetchedRows.length > 0) {
    const { strokes, lastTsByStroke } = applyTileEvents(preFetchedRows);
    let filtered = strokes.filter((s) =>
      s.points.some(([x, y]) => x >= bbox.x1 && x < bbox.x2 && y >= bbox.y1 && y < bbox.y2)
    );
    if (sinceVersion != null) {
      filtered = filtered.filter((s) => (lastTsByStroke.get(s.id) ?? 0) > sinceVersion);
    }
    return filtered;
  }
  return getStrokesForTile(tileX, tileY, roomId, sinceVersion);
}

function getBrushStyle(tool: string): { opacity: number; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin; dash: number[] } {
  switch (tool) {
    case 'pen':
      return { opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] };
    case 'brush':
      return { opacity: 0.8, lineCap: 'round', lineJoin: 'round', dash: [] };
    case 'marker':
      return { opacity: 0.7, lineCap: 'square', lineJoin: 'miter', dash: [] };
    case 'highlighter':
      return { opacity: 0.4, lineCap: 'round', lineJoin: 'round', dash: [] };
    case 'pencil':
      return { opacity: 0.9, lineCap: 'round', lineJoin: 'round', dash: [] };
    case 'chalk':
      return { opacity: 0.85, lineCap: 'round', lineJoin: 'round', dash: [5, 5] };
    case 'eraser':
      return { opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] };
    default:
      return { opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] };
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
    const roomId = (req.query.roomId as string) || DEFAULT_ROOM;
    const x1 = parseFloat(req.query.x1 as string);
    const y1 = parseFloat(req.query.y1 as string);
    const x2 = parseFloat(req.query.x2 as string);
    const y2 = parseFloat(req.query.y2 as string);
    const sinceVersion = req.query.sinceVersion ? parseInt(req.query.sinceVersion as string) : undefined;

    console.log(`[TileService] GET /tiles: room=${roomId}, x1=${x1}, y1=${y1}, x2=${x2}, y2=${y2}`);

    if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const [minTileX, minTileY] = getTileCoords(x1, y1);
    const [maxTileX, maxTileY] = getTileCoords(x2, y2);

    console.log(`[TileService] Tiles range: X[${minTileX}..${maxTileX}], Y[${minTileY}..${maxTileY}]`);

    // Ограничиваем количество тайлов в одном запросе (максимум 100)
    const maxTiles = 100;
    const tileCount = (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
    if (tileCount > maxTiles) {
      console.warn(`[TileService] Requested ${tileCount} tiles, limiting to ${maxTiles}`);
      // Ограничиваем диапазон
      const maxTileRange = Math.floor(Math.sqrt(maxTiles));
      const limitedMaxTileX = Math.min(maxTileX, minTileX + maxTileRange - 1);
      const limitedMaxTileY = Math.min(maxTileY, minTileY + maxTileRange - 1);
      console.log(`[TileService] Limited range: X[${minTileX}..${limitedMaxTileX}], Y[${minTileY}..${limitedMaxTileY}]`);
    }

    // Собираем все тайлы для параллельной обработки
    const tileCoords: Array<[number, number]> = [];
    const finalMaxTileX = tileCount > maxTiles ? Math.min(maxTileX, minTileX + Math.floor(Math.sqrt(maxTiles)) - 1) : maxTileX;
    const finalMaxTileY = tileCount > maxTiles ? Math.min(maxTileY, minTileY + Math.floor(Math.sqrt(maxTiles)) - 1) : maxTileY;
    for (let tileX = minTileX; tileX <= finalMaxTileX; tileX++) {
      for (let tileY = minTileY; tileY <= finalMaxTileY; tileY++) {
        tileCoords.push([tileX, tileY]);
      }
    }

    const tileIds = tileCoords.map(([tx, ty]) => encodeTileId(tx, ty));
    const eventsByTileId = await getTileEventsBatch(roomId, tileIds);

    // Обрабатываем тайлы (данные уже из одного запроса по tile_id IN (...))
    const tilePromises = tileCoords.map(async ([tileX, tileY]) => {
      const latestSnapshot = await pool.query(
        `SELECT snapshot_url, version FROM tile_snapshots 
         WHERE room_id = $1 AND tile_x = $2 AND tile_y = $3 
         ORDER BY version DESC LIMIT 1`,
        [roomId, tileX, tileY]
      );

      let snapshotUrl: string | undefined;
      let strokes: Stroke[] = [];
      let version: number;

      if (latestSnapshot.rows.length > 0 && (!sinceVersion || parseInt(latestSnapshot.rows[0].version) >= sinceVersion)) {
        snapshotUrl = latestSnapshot.rows[0].snapshot_url;
        version = parseInt(latestSnapshot.rows[0].version);
      } else {
        strokes = await getStrokesForTileWithEvents(
          tileX,
          tileY,
          roomId,
          sinceVersion,
          eventsByTileId.get(encodeTileId(tileX, tileY))
        );

        version = latestSnapshot.rows.length > 0
          ? parseInt(latestSnapshot.rows[0].version)
          : Date.now();

        if (strokes.length > 0) {
          const snapshotVersion = Date.now();
          const snapshotKey = `room_${roomId}/tile_${tileX}_${tileY}_${snapshotVersion}.png`;

          const snapshotBuffer = await renderTileSnapshot(tileX, tileY, strokes);
          await minioClient.putObject(BUCKET_NAME, snapshotKey, snapshotBuffer, snapshotBuffer.length, {
            'Content-Type': 'image/png',
          });

          snapshotUrl = `/snapshots/${snapshotKey}`;

          await pool.query(
            `INSERT INTO tile_snapshots (room_id, tile_x, tile_y, version, snapshot_url) 
             VALUES ($1, $2, $3, $4, $5)`,
            [roomId, tileX, tileY, snapshotVersion, snapshotUrl]
          );

          version = snapshotVersion;
        }
      }

      return {
        tileX,
        tileY,
        version,
        snapshotUrl,
        strokes, // Отправляем strokes только если нет снапшота или он устарел
      };
    });

    const tiles = await Promise.all(tilePromises);

    res.json({ tiles });
  } catch (error) {
    console.error('Error fetching tiles:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /snapshots/:key - отдать снапшот из MinIO (key может содержать room_1/tile_...)
app.get(/^\/snapshots\/(.+)$/, async (req, res) => {
  try {
    const key = (req.params as { 0: string })[0];
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

if (process.env.NODE_ENV !== 'test') {
  start();
}

export { app };
