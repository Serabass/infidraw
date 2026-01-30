import express from 'express';
import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import { createClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { Stroke, StrokeEvent } from './types';
import { db, pool } from './db';
import type { Database } from './db';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.raw({ type: 'application/msgpack', limit: '10mb' }));

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS talkers (
      id VARCHAR(36) PRIMARY KEY,
      room_id VARCHAR(64) NOT NULL,
      x DOUBLE PRECISION NOT NULL,
      y DOUBLE PRECISION NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_talkers_room_id ON talkers(room_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS talker_messages (
      id VARCHAR(36) PRIMARY KEY,
      talker_id VARCHAR(36) NOT NULL,
      room_id VARCHAR(64) NOT NULL,
      author_name VARCHAR(255) NOT NULL,
      text TEXT NOT NULL,
      ts BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_talker_messages_talker_id ON talker_messages(talker_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_talker_messages_room_ts ON talker_messages(room_id, ts);
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
      rawBody = msgpackDecode(new Uint8Array(req.body));
    }
    const roomId = (rawBody as { roomId?: string }).roomId || DEFAULT_ROOM;
    const bodyObj = typeof rawBody === 'object' && rawBody !== null ? rawBody : {};
    console.log(
      `[EventStore] Received stroke request: room=${roomId}, tool=${(bodyObj as { tool?: string }).tool}, points=${Array.isArray((bodyObj as { points?: unknown[] }).points) ? (bodyObj as { points: unknown[] }).points.length : 0}`
    );
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

    await db
      .insertInto('stroke_events')
      .values({
        event_type: event.type,
        stroke_id: event.strokeId,
        stroke_data: stroke,
        timestamp: event.timestamp,
        min_x: minX,
        min_y: minY,
        max_x: maxX,
        max_y: maxY,
        room_id: roomId,
      })
      .execute();

    const tileIds = getTileIdsForBbox(minX, minY, maxX, maxY);
    if (tileIds.length > 0) {
      await db
        .insertInto('tile_events')
        .values(
          tileIds.map((tileId) => ({
            room_id: roomId,
            tile_id: tileId,
            stroke_id: event.strokeId,
            event_type: event.type,
            payload: stroke,
            ts: event.timestamp,
          }))
        )
        .execute();
    }

    await redisClient.del(EVENTS_FULL_CACHE_PREFIX + roomId).catch(() => { });

    const eventPayload = { ...event, roomId };
    const eventBytes = Buffer.from(msgpackEncode(eventPayload));
    await redisClient.publish('stroke_events', eventBytes);
    console.log(
      `[EventStore] Published stroke event to Redis (msgpack): ${event.strokeId}, tool=${stroke.tool}, points=${stroke.points.length}, color=${stroke.color}`
    );

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
    const row = await db
      .selectFrom('stroke_events')
      .select('stroke_data')
      .where('stroke_id', '=', id)
      .where('event_type', '=', 'stroke_created')
      .where('room_id', '=', roomId)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (!row) {
      return res.status(404).json({ error: 'Stroke not found' });
    }

    res.json(row.stroke_data);
  } catch (error) {
    console.error('Error fetching stroke:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Send events payload as JSON or MessagePack depending on Accept */
function sendEventsPayload(
  res: express.Response,
  payload: { events: StrokeEvent[]; roomId: string; roomName: string },
  acceptHeader: string | undefined
): void {
  const useMsgpack = acceptHeader != null && acceptHeader.includes('application/msgpack');
  if (useMsgpack) {
    res.setHeader('Content-Type', 'application/msgpack');
    res.send(Buffer.from(msgpackEncode(payload)));
  } else {
    res.json(payload);
  }
}

// GET /events - получить события и название комнаты (roomName по тому же маршруту, что и /api/events)
app.get('/events', async (req, res) => {
  const totalStart = Date.now();
  const acceptHeader = req.get('Accept');
  try {
    const roomId = (req.query.roomId as string) || DEFAULT_ROOM;
    const since = parseInt(req.query.since as string) || 0;
    const limitParam = parseInt(req.query.limit as string);
    const limit = Number.isNaN(limitParam) ? (since === 0 ? 10000 : 100) : Math.min(Math.max(0, limitParam), 10000);

    // Full sync (since=0, no limit or limit matches cache): try Redis cache
    // Only use cache when we would return the full cached payload (no limit or limit >= cached length)
    if (since === 0) {
      const cacheKey = EVENTS_FULL_CACHE_PREFIX + roomId;
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          const payload = JSON.parse(cached) as { events: StrokeEvent[]; roomId: string; roomName: string };
          const cachedCount = payload.events.length;
          const useCache = limit >= cachedCount;
          if (useCache) {
            console.log(
              `[EventStore] GET /events room=${roomId} cache HIT, ${cachedCount} events, ${Date.now() - totalStart}ms`
            );
            return sendEventsPayload(res, payload, acceptHeader);
          }
          // Client asked for fewer events (e.g. limit=500): slice cached payload and return
          if (limit < cachedCount) {
            const sliced = { ...payload, events: payload.events.slice(0, limit) };
            console.log(
              `[EventStore] GET /events room=${roomId} cache HIT (sliced to ${limit}), ${Date.now() - totalStart}ms`
            );
            return sendEventsPayload(res, sliced, acceptHeader);
          }
        }
      } catch (e) {
        // cache miss or parse error — fall through to DB
      }
    }

    const queryStart = Date.now();
    const [eventsRows, nameRow] = await Promise.all([
      db
        .selectFrom('stroke_events')
        .select(['event_type', 'stroke_id', 'stroke_data', 'timestamp'])
        .where('room_id', '=', roomId)
        .where('timestamp', '>', since)
        .orderBy('timestamp', 'asc')
        .limit(limit)
        .execute(),
      db.selectFrom('rooms').select('name').where('room_id', '=', roomId).executeTakeFirst(),
    ]);
    const queryMs = Date.now() - queryStart;

    type EventsRow = Pick<Database['stroke_events'], 'event_type' | 'stroke_id' | 'stroke_data' | 'timestamp'>;
    const events: StrokeEvent[] = eventsRows.map((row: EventsRow) => ({
      type: row.event_type as StrokeEvent['type'],
      strokeId: row.stroke_id,
      stroke: row.stroke_data,
      timestamp: Number(row.timestamp),
    }));

    const roomName = nameRow?.name ?? `Room ${roomId}`;

    const payload = { events, roomId, roomName };
    if (since === 0) {
      const cacheKey = EVENTS_FULL_CACHE_PREFIX + roomId;
      await redisClient.setEx(cacheKey, EVENTS_FULL_CACHE_TTL_SEC, JSON.stringify(payload)).catch(() => { });
    }

    const totalMs = Date.now() - totalStart;
    console.log(
      `[EventStore] GET /events room=${roomId} since=${since} rows=${events.length} db=${queryMs}ms total=${totalMs}ms`
    );

    sendEventsPayload(res, payload, acceptHeader);
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

    await db
      .insertInto('stroke_events')
      .values({
        event_type: event.type,
        stroke_id: strokeId,
        stroke_data: strokeData,
        timestamp,
        room_id: roomId,
      })
      .execute();

    const bboxRow = await db
      .selectFrom('stroke_events')
      .select(['min_x', 'min_y', 'max_x', 'max_y'])
      .where('stroke_id', '=', strokeId)
      .where('event_type', '=', 'stroke_created')
      .where('room_id', '=', roomId)
      .where('min_x', 'is not', null)
      .limit(1)
      .executeTakeFirst();
    if (bboxRow && bboxRow.min_x != null && bboxRow.min_y != null && bboxRow.max_x != null && bboxRow.max_y != null) {
      const tileIds = getTileIdsForBbox(bboxRow.min_x, bboxRow.min_y, bboxRow.max_x, bboxRow.max_y);
      const payload = { hiddenPointIndices: body.hiddenPointIndices };
      if (tileIds.length > 0) {
        await db
          .insertInto('tile_events')
          .values(
            tileIds.map((tileId) => ({
              room_id: roomId,
              tile_id: tileId,
              stroke_id: strokeId,
              event_type: 'stroke_erased',
              payload,
              ts: timestamp,
            }))
          )
          .execute();
      }
    }

    await redisClient.del(EVENTS_FULL_CACHE_PREFIX + roomId).catch(() => { });

    const eventPayload = { ...event, hiddenPointIndices: body.hiddenPointIndices, roomId };
    const eventBytes = Buffer.from(msgpackEncode(eventPayload));
    await redisClient.publish('stroke_events', eventBytes);
    console.log(
      `[EventStore] Published stroke_erased (msgpack): ${strokeId}, points: ${body.hiddenPointIndices.length}`
    );

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
    const [roomsRows, usedRows] = await Promise.all([
      db.selectFrom('rooms').select(['room_id', 'name', 'updated_at']).orderBy('updated_at', 'desc').execute(),
      db.selectFrom('stroke_events').select('room_id').distinct().execute(),
    ]);
    type RoomsRow = Database['rooms'];
    type UsedRoomRow = { room_id: string };
    const byId = new Map<string, { name: string; updatedAt: number }>();
    for (const row of roomsRows as RoomsRow[]) {
      const updatedAt = Number(row.updated_at) || 0;
      byId.set(row.room_id, { name: row.name, updatedAt });
    }
    const roomIds = new Set((usedRows as UsedRoomRow[]).map((r) => r.room_id));
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
    await db
      .insertInto('rooms')
      .values({ room_id: roomId, name, updated_at: updatedAt })
      .onConflict((oc: { column: (c: 'room_id') => { doUpdateSet: (s: object) => unknown } }) =>
        oc.column('room_id').doUpdateSet({ name, updated_at: updatedAt })
      )
      .execute();
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
    const row = await db
      .selectFrom('rooms')
      .select(['room_id', 'name', 'updated_at'])
      .where('room_id', '=', roomId)
      .executeTakeFirst();
    if (!row) {
      return res.json({ roomId, name: `Room ${roomId}`, updatedAt: 0 });
    }
    res.json({ roomId: row.room_id, name: row.name, updatedAt: Number(row.updated_at) });
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
    await db
      .insertInto('rooms')
      .values({ room_id: roomId, name, updated_at: updatedAt })
      .onConflict((oc: { column: (c: 'room_id') => { doUpdateSet: (s: object) => unknown } }) =>
        oc.column('room_id').doUpdateSet({ name, updated_at: updatedAt })
      )
      .execute();
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

// ——— Talkers (govorilki) ———
// GET /talkers?roomId= — list talkers in room
app.get('/talkers', async (req, res) => {
  try {
    const roomId = (req.query.roomId as string) || DEFAULT_ROOM;
    const rows = await db
      .selectFrom('talkers')
      .select(['id', 'room_id', 'x', 'y', 'created_at'])
      .where('room_id', '=', roomId)
      .orderBy('created_at', 'asc')
      .execute();
    type TalkerRow = Database['talkers'];
    const talkers = (rows as TalkerRow[]).map((r) => ({
      id: r.id,
      roomId: r.room_id,
      x: Number(r.x),
      y: Number(r.y),
      createdAt: Number(r.created_at),
    }));
    res.json({ talkers });
  } catch (error) {
    console.error('Error listing talkers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /talkers — create talker (body: roomId?, x, y)
const TalkerCreateSchema = z.object({
  roomId: z.string().optional(),
  x: z.number(),
  y: z.number(),
});
app.post('/talkers', async (req, res) => {
  try {
    const body = TalkerCreateSchema.parse(req.body);
    const roomId = body.roomId || DEFAULT_ROOM;
    const id = uuidv4();
    const createdAt = Date.now();
    await db
      .insertInto('talkers')
      .values({ id, room_id: roomId, x: body.x, y: body.y, created_at: createdAt })
      .execute();
    const talker = { id, roomId, x: body.x, y: body.y, createdAt };
    const eventJson = JSON.stringify({ type: 'talker_created', roomId, talker });
    await redisClient.publish('talker_events', eventJson);
    console.log(`[EventStore] Talker created: ${id} at (${body.x}, ${body.y}) room=${roomId}`);
    res.status(201).json(talker);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid talker data', details: error.errors });
    }
    console.error('Error creating talker:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /talkers/:id/messages?roomId=&limit=
app.get('/talkers/:id/messages', async (req, res) => {
  try {
    const talkerId = req.params.id;
    const roomId = (req.query.roomId as string) || DEFAULT_ROOM;
    const limitParam = parseInt(req.query.limit as string);
    const limit = Number.isNaN(limitParam) ? 100 : Math.min(Math.max(1, limitParam), 500);
    const rows = await db
      .selectFrom('talker_messages')
      .select(['id', 'talker_id', 'room_id', 'author_name', 'text', 'ts'])
      .where('talker_id', '=', talkerId)
      .where('room_id', '=', roomId)
      .orderBy('ts', 'asc')
      .limit(limit)
      .execute();
    type MessageRow = Database['talker_messages'];
    const messages = (rows as MessageRow[]).map((r) => ({
      id: r.id,
      talkerId: r.talker_id,
      roomId: r.room_id,
      authorName: r.author_name,
      text: r.text,
      ts: Number(r.ts),
    }));
    res.json({ messages });
  } catch (error) {
    console.error('Error listing talker messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /talkers/:id/messages — send message (body: roomId?, authorName, text)
const TalkerMessageSchema = z.object({
  roomId: z.string().optional(),
  authorName: z.string().min(1).max(255),
  text: z.string().max(10000),
});
app.post('/talkers/:id/messages', async (req, res) => {
  try {
    const talkerId = req.params.id;
    const body = TalkerMessageSchema.parse(req.body);
    const roomId = body.roomId || DEFAULT_ROOM;
    const id = uuidv4();
    const ts = Date.now();
    await db
      .insertInto('talker_messages')
      .values({
        id,
        talker_id: talkerId,
        room_id: roomId,
        author_name: body.authorName,
        text: body.text,
        ts,
      })
      .execute();
    const message = { id, talkerId, roomId, authorName: body.authorName, text: body.text, ts };
    const eventJson = JSON.stringify({ type: 'talker_message', roomId, message });
    await redisClient.publish('talker_events', eventJson);
    console.log(`[EventStore] Talker message: ${talkerId} from "${body.authorName}"`);
    res.status(201).json(message);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid message data', details: error.errors });
    }
    console.error('Error creating talker message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
