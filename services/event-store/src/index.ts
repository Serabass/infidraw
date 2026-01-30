import express from 'express';
import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { Stroke, StrokeEvent } from './types';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.raw({ type: 'application/msgpack', limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const TILE_SIZE = parseInt(process.env.TILE_SIZE || '512');
const TILE_ID_OFFSET = 500_000;

/** Encode (tileX, tileY) as single bigint for index-friendly lookups. Supports negative coords. */
function encodeTileId(tileX: number, tileY: number): number {
  return (tileX + TILE_ID_OFFSET) * 1_000_000 + (tileY + TILE_ID_OFFSET);
}

/** Which tile ids does a bbox touch? */
function getTileIdsForBbox(minX: number, minY: number, maxX: number, maxY: number): number[] {
  const minTileX = Math.floor(minX / TILE_SIZE);
  const minTileY = Math.floor(minY / TILE_SIZE);
  const maxTileX = Math.floor(maxX / TILE_SIZE);
  const maxTileY = Math.floor(maxY / TILE_SIZE);
  const ids: number[] = [];
  for (let tx = minTileX; tx <= maxTileX; tx++) {
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      ids.push(encodeTileId(tx, ty));
    }
  }
  return ids;
}

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

const EVENTS_FULL_CACHE_PREFIX = 'events:full:';
const EVENTS_FULL_CACHE_TTL_SEC = 10;

const StrokeSchema = z.object({
  tool: z.enum(['pen', 'brush', 'marker', 'highlighter', 'eraser', 'pencil', 'chalk']),
  color: z.string(),
  width: z.number().positive(),
  points: z.array(z.tuple([z.number(), z.number()])).min(1),
  authorId: z.string().optional(),
  roomId: z.string().optional(),
});

async function initDb() {
  await pool.query(`
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
    );
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stroke_events' AND column_name = 'room_id') THEN
        ALTER TABLE stroke_events ADD COLUMN room_id VARCHAR(64) NOT NULL DEFAULT '1';
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_stroke_events_room_id ON stroke_events(room_id);
  `);

  // Migration: add bbox columns if table existed from older schema (without min_x/max_x etc.)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stroke_events' AND column_name = 'min_x') THEN
        ALTER TABLE stroke_events ADD COLUMN min_x DOUBLE PRECISION;
        ALTER TABLE stroke_events ADD COLUMN min_y DOUBLE PRECISION;
        ALTER TABLE stroke_events ADD COLUMN max_x DOUBLE PRECISION;
        ALTER TABLE stroke_events ADD COLUMN max_y DOUBLE PRECISION;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_stroke_id ON stroke_events(stroke_id);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON stroke_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_type ON stroke_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_stroke_coords ON stroke_events(min_x, min_y, max_x, max_y) 
      WHERE event_type = 'stroke_created' AND min_x IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_stroke_events_room_timestamp ON stroke_events(room_id, timestamp);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL DEFAULT 'Room',
      updated_at BIGINT NOT NULL DEFAULT 0
    );
  `);

  // tile_id + seq pattern: query by tile_id IN (...), delta by seq > since_seq
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tile_events (
      id BIGSERIAL PRIMARY KEY,
      room_id VARCHAR(64) NOT NULL,
      tile_id BIGINT NOT NULL,
      stroke_id VARCHAR(36) NOT NULL,
      event_type VARCHAR(50) NOT NULL,
      payload JSONB,
      ts BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tile_events_room_tile_id
      ON tile_events (room_id, tile_id, id);
  `);
}

async function initRedis() {
  await redisClient.connect();
}

const DEFAULT_ROOM = '1';

// POST /strokes - создать новый stroke (accepts JSON or application/msgpack)
app.post('/strokes', async (req, res) => {
  try {
    let rawBody: unknown = req.body;
    if (req.is('application/msgpack') && Buffer.isBuffer(req.body)) {
      rawBody = msgpackDecode(new Uint8Array(req.body)) as unknown;
    }
    const roomId = (rawBody as { roomId?: string }).roomId || DEFAULT_ROOM;
    const bodyObj = typeof rawBody === 'object' && rawBody !== null ? rawBody : {};
    console.log(`[EventStore] Received stroke request: room=${roomId}, tool=${(bodyObj as { tool?: string }).tool}, points=${Array.isArray((bodyObj as { points?: unknown[] }).points) ? (bodyObj as { points: unknown[] }).points.length : 0}`);
    const body = StrokeSchema.parse(bodyObj);
    const strokeId = uuidv4();
    const timestamp = Date.now();

    const stroke: Stroke = {
      id: strokeId,
      ts: timestamp,
      tool: body.tool,
      color: body.color,
      width: body.width,
      points: body.points,
      authorId: body.authorId,
    };

    // Вычисляем bbox для быстрого поиска по тайлам
    const xs = body.points.map(([x]) => x);
    const ys = body.points.map(([, y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    const event: StrokeEvent = {
      type: 'stroke_created',
      strokeId,
      stroke,
      timestamp,
    };

    await pool.query(
      'INSERT INTO stroke_events (event_type, stroke_id, stroke_data, timestamp, min_x, min_y, max_x, max_y, room_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [event.type, event.strokeId, JSON.stringify(stroke), event.timestamp, minX, minY, maxX, maxY, roomId]
    );

    const tileIds = getTileIdsForBbox(minX, minY, maxX, maxY);
    if (tileIds.length > 0) {
      const payload = JSON.stringify(stroke);
      const values = tileIds.map((_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`).join(', ');
      const params = tileIds.flatMap((tileId) => [roomId, tileId, event.strokeId, event.type, payload, event.timestamp]);
      await pool.query(
        `INSERT INTO tile_events (room_id, tile_id, stroke_id, event_type, payload, ts) VALUES ${values}`,
        params
      );
    }

    await redisClient.del(EVENTS_FULL_CACHE_PREFIX + roomId).catch(() => {});

    const eventPayload = { ...event, roomId };
    const eventBytes = Buffer.from(msgpackEncode(eventPayload));
    await redisClient.publish('stroke_events', eventBytes);
    console.log(`[EventStore] Published stroke event to Redis (msgpack): ${event.strokeId}, tool=${stroke.tool}, points=${stroke.points.length}, color=${stroke.color}`);

    res.status(201).json({ strokeId, stroke });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid stroke data', details: error.errors });
    }
    console.error('Error creating stroke:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /strokes/:id - получить stroke по ID
app.get('/strokes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const roomId = (req.query.roomId as string) || DEFAULT_ROOM;
    const result = await pool.query(
      `SELECT stroke_data FROM stroke_events 
       WHERE stroke_id = $1 AND event_type = 'stroke_created' AND room_id = $2
       ORDER BY timestamp DESC LIMIT 1`,
      [id, roomId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Stroke not found' });
    }

    res.json(result.rows[0].stroke_data);
  } catch (error) {
    console.error('Error fetching stroke:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /events - получить события и название комнаты (roomName по тому же маршруту, что и /api/events)
app.get('/events', async (req, res) => {
  const totalStart = Date.now();
  try {
    const roomId = (req.query.roomId as string) || DEFAULT_ROOM;
    const since = parseInt(req.query.since as string) || 0;
    const limitParam = parseInt(req.query.limit as string);
    const limit = Number.isNaN(limitParam)
      ? (since === 0 ? 10000 : 100)
      : Math.min(Math.max(0, limitParam), 10000);

    // Full sync (since=0): try Redis cache to avoid slow DB on repeated requests
    if (since === 0) {
      const cacheKey = EVENTS_FULL_CACHE_PREFIX + roomId;
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          const payload = JSON.parse(cached) as { events: StrokeEvent[]; roomId: string; roomName: string };
          console.log(`[EventStore] GET /events room=${roomId} cache HIT, ${payload.events.length} events, ${Date.now() - totalStart}ms`);
          return res.json(payload);
        }
      } catch (e) {
        // cache miss or parse error — fall through to DB
      }
    }

    const queryStart = Date.now();
    const [result, nameRow] = await Promise.all([
      pool.query(
        `SELECT event_type, stroke_id, stroke_data, timestamp 
         FROM stroke_events 
         WHERE room_id = $1 AND timestamp > $2 
         ORDER BY timestamp ASC 
         LIMIT $3`,
        [roomId, since, limit]
      ),
      pool.query('SELECT name FROM rooms WHERE room_id = $1', [roomId]),
    ]);
    const queryMs = Date.now() - queryStart;

    const events: StrokeEvent[] = result.rows.map((row) => ({
      type: row.event_type as StrokeEvent['type'],
      strokeId: row.stroke_id,
      stroke: row.stroke_data,
      timestamp: parseInt(row.timestamp),
    }));

    const roomName = nameRow.rows.length > 0
      ? (nameRow.rows[0] as { name: string }).name
      : `Room ${roomId}`;

    const payload = { events, roomId, roomName };
    if (since === 0) {
      const cacheKey = EVENTS_FULL_CACHE_PREFIX + roomId;
      await redisClient.setEx(cacheKey, EVENTS_FULL_CACHE_TTL_SEC, JSON.stringify(payload)).catch(() => {});
    }

    const totalMs = Date.now() - totalStart;
    console.log(`[EventStore] GET /events room=${roomId} since=${since} rows=${events.length} db=${queryMs}ms total=${totalMs}ms`);

    res.json(payload);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


const EraseBodySchema = z.object({
  hiddenPointIndices: z.array(z.number().int().min(0)).min(1),
  roomId: z.string().optional(),
});

// POST /strokes/:id/erase - сохранить стирание точек штриха (ластик)
app.post('/strokes/:id/erase', async (req, res) => {
  try {
    const strokeId = req.params.id;
    const parsed = EraseBodySchema.parse(req.body);
    const body = { hiddenPointIndices: parsed.hiddenPointIndices };
    const roomId = parsed.roomId || DEFAULT_ROOM;
    const timestamp = Date.now();
    const event: StrokeEvent = {
      type: 'stroke_erased',
      strokeId,
      timestamp,
    };
    const strokeData = JSON.stringify({ hiddenPointIndices: body.hiddenPointIndices });

    await pool.query(
      'INSERT INTO stroke_events (event_type, stroke_id, stroke_data, timestamp, room_id) VALUES ($1, $2, $3, $4, $5)',
      [event.type, strokeId, strokeData, timestamp, roomId]
    );

    const bboxRow = await pool.query(
      `SELECT min_x, min_y, max_x, max_y FROM stroke_events 
       WHERE stroke_id = $1 AND event_type = 'stroke_created' AND room_id = $2 AND min_x IS NOT NULL LIMIT 1`,
      [strokeId, roomId]
    );
    if (bboxRow.rows.length > 0) {
      const { min_x, min_y, max_x, max_y } = bboxRow.rows[0];
      const tileIds = getTileIdsForBbox(min_x, min_y, max_x, max_y);
      const payload = JSON.stringify({ hiddenPointIndices: body.hiddenPointIndices });
      if (tileIds.length > 0) {
        const values = tileIds.map((_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`).join(', ');
        const params = tileIds.flatMap((tileId) => [roomId, tileId, strokeId, 'stroke_erased', payload, timestamp]);
        await pool.query(
          `INSERT INTO tile_events (room_id, tile_id, stroke_id, event_type, payload, ts) VALUES ${values}`,
          params
        );
      }
    }

    await redisClient.del(EVENTS_FULL_CACHE_PREFIX + roomId).catch(() => {});

    const eventPayload = { ...event, hiddenPointIndices: body.hiddenPointIndices, roomId };
    const eventBytes = Buffer.from(msgpackEncode(eventPayload));
    await redisClient.publish('stroke_events', eventBytes);
    console.log(`[EventStore] Published stroke_erased (msgpack): ${strokeId}, points: ${body.hiddenPointIndices.length}`);

    res.status(201).json({ strokeId, hiddenPointIndices: body.hiddenPointIndices });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid erase data', details: error.errors });
    }
    console.error('Error saving erase:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /rooms — список всех комнат (из таблицы rooms + room_id из stroke_events без записи в rooms)
app.get('/rooms', async (req, res) => {
  try {
    const [roomsResult, usedResult] = await Promise.all([
      pool.query('SELECT room_id, name, updated_at FROM rooms ORDER BY updated_at DESC'),
      pool.query('SELECT DISTINCT room_id FROM stroke_events'),
    ]);
    const byId = new Map<string, { name: string; updatedAt: number }>();
    for (const row of roomsResult.rows as Array<{ room_id: string; name: string; updated_at: string | number }>) {
      const updatedAt = Number(row.updated_at) || 0;
      byId.set(row.room_id, { name: row.name, updatedAt });
    }
    const roomIds = new Set<string>(usedResult.rows.map((r: { room_id: string }) => r.room_id));
    for (const id of roomIds) {
      if (!byId.has(id)) {
        byId.set(id, { name: `Room ${id}`, updatedAt: 0 });
      }
    }
    const rooms = Array.from(byId.entries()).map(([roomId, data]) => ({
      roomId,
      name: data.name,
      updatedAt: data.updatedAt,
    }));
    rooms.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ rooms });
  } catch (error) {
    console.error('Error listing rooms:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const RoomNameSchema = z.object({ name: z.string().min(1).max(255) });

// ВАЖНО: более специфичный маршрут /rename — первым, иначе /rooms/1/rename матчится как /rooms/:roomId с roomId="1/rename"
app.get('/rooms/:roomId/rename', async (req, res) => {
  const roomId = req.params.roomId || DEFAULT_ROOM;
  const raw = (req.query.name as string) || '';
  const name = raw.trim();
  if (!name) {
    return res.status(400).json({ error: 'Query param name is required' });
  }
  if (name.length > 255) {
    return res.status(400).json({ error: 'Name too long' });
  }
  try {
    const updatedAt = Date.now();
    await pool.query(
      `INSERT INTO rooms (room_id, name, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (room_id) DO UPDATE SET name = $2, updated_at = $3`,
      [roomId, name, updatedAt]
    );
    const eventJson = JSON.stringify({ type: 'room_renamed', roomId, name, updatedAt });
    await redisClient.publish('room_events', eventJson);
    console.log(`[EventStore] Room renamed (GET): ${roomId} -> "${name}"`);
    res.json({ roomId, name, updatedAt });
  } catch (error) {
    console.error('Error updating room name:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /rooms/:roomId - получить название комнаты
app.get('/rooms/:roomId', async (req, res) => {
  try {
    const roomId = req.params.roomId || DEFAULT_ROOM;
    const result = await pool.query(
      'SELECT room_id, name, updated_at FROM rooms WHERE room_id = $1',
      [roomId]
    );
    if (result.rows.length === 0) {
      return res.json({ roomId, name: `Room ${roomId}`, updatedAt: 0 });
    }
    const row = result.rows[0];
    res.json({ roomId: row.room_id, name: row.name, updatedAt: parseInt(row.updated_at) });
  } catch (error) {
    console.error('Error fetching room:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function handleSetRoomName(req: express.Request, res: express.Response): Promise<void> {
  try {
    const roomId = req.params.roomId || DEFAULT_ROOM;
    const body = RoomNameSchema.parse(req.body);
    const name = body.name.trim();
    const updatedAt = Date.now();
    await pool.query(
      `INSERT INTO rooms (room_id, name, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (room_id) DO UPDATE SET name = $2, updated_at = $3`,
      [roomId, name, updatedAt]
    );
    const eventJson = JSON.stringify({ type: 'room_renamed', roomId, name, updatedAt });
    await redisClient.publish('room_events', eventJson);
    console.log(`[EventStore] Room renamed: ${roomId} -> "${name}"`);
    res.json({ roomId, name, updatedAt });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid name', details: error.errors });
      return;
    }
    console.error('Error updating room name:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PUT и POST — изменить название комнаты (если прокси вдруг пропустит)
app.put('/rooms/:roomId', handleSetRoomName);
app.post('/rooms/:roomId', handleSetRoomName);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initDb();
    await initRedis();
    app.listen(PORT, () => {
      console.log(`Event Store service running on port ${PORT}`);
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
