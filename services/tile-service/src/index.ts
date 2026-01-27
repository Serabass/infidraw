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
    
    -- Убеждаемся что поля bbox существуют в stroke_events (если их еще нет)
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
    
    -- Создаем индексы для быстрого поиска по bbox (если их еще нет)
    -- Используем обычный B-tree индекс вместо GIST для простоты (GIST требует расширение)
    CREATE INDEX IF NOT EXISTS idx_stroke_coords ON stroke_events(min_x, min_y, max_x, max_y) 
      WHERE event_type = 'stroke_created' AND min_x IS NOT NULL;
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

  // Оптимизированный запрос: фильтруем по bbox прямо в SQL
  // Используем проверку пересечения bounding box'ов: stroke пересекается с тайлом если
  // не (stroke.max_x < tile.x1 OR stroke.min_x >= tile.x2 OR stroke.max_y < tile.y1 OR stroke.min_y >= tile.y2)
  const query = `
    SELECT stroke_data, timestamp
    FROM stroke_events 
    WHERE event_type = 'stroke_created' 
      AND stroke_data->>'hidden' IS DISTINCT FROM 'true'
      AND min_x IS NOT NULL
      AND max_x IS NOT NULL
      AND min_y IS NOT NULL
      AND max_y IS NOT NULL
      AND NOT (max_x < $1 OR min_x >= $2 OR max_y < $3 OR min_y >= $4)
      ${sinceVersion ? 'AND timestamp > $5' : ''}
    ORDER BY timestamp DESC
    LIMIT 10000
  `;

  const startTime = Date.now();
  const params = sinceVersion 
    ? [bbox.x1, bbox.x2, bbox.y1, bbox.y2, sinceVersion]
    : [bbox.x1, bbox.x2, bbox.y1, bbox.y2];
  const result = await pool.query(query, params);
  const queryTime = Date.now() - startTime;

  // Теперь фильтруем только по точкам (bbox может быть больше чем реальные точки)
  // Но это уже намного меньше данных чем было раньше
  const filterStartTime = Date.now();
  const strokes = result.rows
    .map((row) => row.stroke_data as Stroke)
    .filter((stroke) => {
      // Проверяем, есть ли хотя бы одна точка stroke в пределах тайла
      return stroke.points.some(
        ([x, y]) => x >= bbox.x1 && x < bbox.x2 && y >= bbox.y1 && y < bbox.y2
      );
    });
  const filterTime = Date.now() - filterStartTime;

  console.log(`[TileService] Tile [${tileX},${tileY}]: found ${strokes.length} strokes from ${result.rows.length} candidates (query: ${queryTime}ms, filter: ${filterTime}ms, bbox: ${bbox.x1},${bbox.y1} - ${bbox.x2},${bbox.y2})`);
  return strokes;
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
    const x1 = parseFloat(req.query.x1 as string);
    const y1 = parseFloat(req.query.y1 as string);
    const x2 = parseFloat(req.query.x2 as string);
    const y2 = parseFloat(req.query.y2 as string);
    const sinceVersion = req.query.sinceVersion ? parseInt(req.query.sinceVersion as string) : undefined;

    console.log(`[TileService] GET /tiles: x1=${x1}, y1=${y1}, x2=${x2}, y2=${y2}`);

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

    // Обрабатываем тайлы параллельно
    const tilePromises = tileCoords.map(async ([tileX, tileY]) => {
      // Сначала проверяем снапшот
      const latestSnapshot = await pool.query(
        `SELECT snapshot_url, version FROM tile_snapshots 
         WHERE tile_x = $1 AND tile_y = $2 
         ORDER BY version DESC LIMIT 1`,
        [tileX, tileY]
      );

      let snapshotUrl: string | undefined;
      let strokes: Stroke[] = [];
      let version: number;

      // Если есть актуальный снапшот, не загружаем strokes
      if (latestSnapshot.rows.length > 0 && (!sinceVersion || parseInt(latestSnapshot.rows[0].version) >= sinceVersion)) {
        snapshotUrl = latestSnapshot.rows[0].snapshot_url;
        version = parseInt(latestSnapshot.rows[0].version);
        // Не загружаем strokes, если есть актуальный снапшот
      } else {
        // Загружаем strokes только если снапшота нет или он устарел
        strokes = await getStrokesForTile(tileX, tileY, sinceVersion);

        version = latestSnapshot.rows.length > 0
          ? parseInt(latestSnapshot.rows[0].version)
          : Date.now();

        // Создаем снапшот только если есть strokes
        if (strokes.length > 0) {
          const snapshotVersion = Date.now();
          const snapshotKey = `tile_${tileX}_${tileY}_${snapshotVersion}.png`;

          const snapshotBuffer = await renderTileSnapshot(tileX, tileY, strokes);
          await minioClient.putObject(BUCKET_NAME, snapshotKey, snapshotBuffer, snapshotBuffer.length, {
            'Content-Type': 'image/png',
          });

          snapshotUrl = `/snapshots/${snapshotKey}`;

          // Сохраняем информацию о снапшоте в БД
          await pool.query(
            `INSERT INTO tile_snapshots (tile_x, tile_y, version, snapshot_url) 
             VALUES ($1, $2, $3, $4)`,
            [tileX, tileY, snapshotVersion, snapshotUrl]
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
