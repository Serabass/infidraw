import express from 'express';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { Stroke, StrokeEvent } from './types';

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

const StrokeSchema = z.object({
  tool: z.enum(['pen', 'brush', 'marker', 'highlighter', 'eraser', 'pencil', 'chalk']),
  color: z.string(),
  width: z.number().positive(),
  points: z.array(z.tuple([z.number(), z.number()])).min(1),
  authorId: z.string().optional(),
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stroke_events (
      id BIGSERIAL PRIMARY KEY,
      event_type VARCHAR(50) NOT NULL,
      stroke_id VARCHAR(36) NOT NULL,
      stroke_data JSONB,
      timestamp BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_stroke_id ON stroke_events(stroke_id);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON stroke_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_type ON stroke_events(event_type);
  `);
}

async function initRedis() {
  await redisClient.connect();
}

// POST /strokes - создать новый stroke
app.post('/strokes', async (req, res) => {
  try {
    const body = StrokeSchema.parse(req.body);
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

    const event: StrokeEvent = {
      type: 'stroke_created',
      strokeId,
      stroke,
      timestamp,
    };

    await pool.query(
      'INSERT INTO stroke_events (event_type, stroke_id, stroke_data, timestamp) VALUES ($1, $2, $3, $4)',
      [event.type, event.strokeId, JSON.stringify(stroke), event.timestamp]
    );

    await redisClient.publish('stroke_events', JSON.stringify(event));

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
    const result = await pool.query(
      `SELECT stroke_data FROM stroke_events 
       WHERE stroke_id = $1 AND event_type = 'stroke_created' 
       ORDER BY timestamp DESC LIMIT 1`,
      [id]
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

// GET /events - получить события (для реалтайм синхронизации)
app.get('/events', async (req, res) => {
  try {
    const since = parseInt(req.query.since as string) || 0;
    const limit = parseInt(req.query.limit as string) || 100;

    const result = await pool.query(
      `SELECT event_type, stroke_id, stroke_data, timestamp 
       FROM stroke_events 
       WHERE timestamp > $1 
       ORDER BY timestamp ASC 
       LIMIT $2`,
      [since, limit]
    );

    const events: StrokeEvent[] = result.rows.map((row) => ({
      type: row.event_type as StrokeEvent['type'],
      strokeId: row.stroke_id,
      stroke: row.stroke_data,
      timestamp: parseInt(row.timestamp),
    }));

    res.json({ events });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
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

start();
