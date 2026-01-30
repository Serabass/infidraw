import type { Generated } from 'kysely';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

/** DB schema for Kysely type-safe query builder */
export interface Database {
  stroke_events: {
    id: Generated<bigint>;
    event_type: string;
    stroke_id: string;
    stroke_data: unknown;
    timestamp: number;
    min_x: number | null;
    min_y: number | null;
    max_x: number | null;
    max_y: number | null;
    room_id: string;
  };
  rooms: {
    room_id: string;
    name: string;
    updated_at: number;
  };
  tile_events: {
    id: Generated<bigint>;
    room_id: string;
    tile_id: number;
    stroke_id: string;
    event_type: string;
    payload: unknown;
    ts: number;
  };
  talkers: {
    id: string;
    room_id: string;
    x: number;
    y: number;
    created_at: number;
  };
  talker_messages: {
    id: string;
    talker_id: string;
    room_id: string;
    author_name: string;
    text: string;
    ts: number;
  };
}

/** Insert types (omit auto-generated columns) */
export type StrokeEventInsert = Omit<Database['stroke_events'], 'id'>;
export type RoomInsert = Database['rooms'];
export type TileEventInsert = Omit<Database['tile_events'], 'id'>;
export type TalkerInsert = Database['talkers'];
export type TalkerMessageInsert = Database['talker_messages'];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export { pool };

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});
