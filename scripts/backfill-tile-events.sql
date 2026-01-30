-- Backfill tile_events from existing stroke_events (stroke_created only).
-- Safe to run: skips rows that already exist in tile_events.
-- TILE_SIZE = 512, tile_id = (tile_x + 500000) * 1000000 + (tile_y + 500000)

INSERT INTO tile_events (room_id, tile_id, stroke_id, event_type, payload, ts)
SELECT s.room_id,
       (tx + 500000) * 1000000 + (ty + 500000) AS tile_id,
       s.stroke_id,
       'stroke_created',
       s.stroke_data,
       s.timestamp
FROM stroke_events s,
     generate_series(
       floor(s.min_x / 512)::int,
       floor((s.max_x - 0.001) / 512)::int
     ) AS tx,
     generate_series(
       floor(s.min_y / 512)::int,
       floor((s.max_y - 0.001) / 512)::int
     ) AS ty
WHERE s.event_type = 'stroke_created'
  AND s.min_x IS NOT NULL
  AND s.max_x IS NOT NULL
  AND s.min_y IS NOT NULL
  AND s.max_y IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tile_events e
    WHERE e.room_id = s.room_id
      AND e.tile_id = (tx + 500000) * 1000000 + (ty + 500000)
      AND e.stroke_id = s.stroke_id
      AND e.event_type = 'stroke_created'
  );
