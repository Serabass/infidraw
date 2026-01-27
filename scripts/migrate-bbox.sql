-- Migrate bbox fields - fill min_x, min_y, max_x, max_y for existing strokes

-- Добавляем колонки если их еще нет
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

-- Обновляем bbox для записей где они еще не заполнены
UPDATE stroke_events
SET 
  min_x = (
    SELECT MIN((point->>0)::double precision)
    FROM jsonb_array_elements(stroke_data->'points') AS point
  ),
  min_y = (
    SELECT MIN((point->>1)::double precision)
    FROM jsonb_array_elements(stroke_data->'points') AS point
  ),
  max_x = (
    SELECT MAX((point->>0)::double precision)
    FROM jsonb_array_elements(stroke_data->'points') AS point
  ),
  max_y = (
    SELECT MAX((point->>1)::double precision)
    FROM jsonb_array_elements(stroke_data->'points') AS point
  )
WHERE event_type = 'stroke_created'
  AND stroke_data IS NOT NULL
  AND stroke_data->'points' IS NOT NULL
  AND jsonb_array_length(stroke_data->'points') > 0
  AND (min_x IS NULL OR min_y IS NULL OR max_x IS NULL OR max_y IS NULL);

-- Создаем индексы если их еще нет
-- Используем B-tree индекс вместо GIST (GIST требует расширение btree_gist)
CREATE INDEX IF NOT EXISTS idx_stroke_coords ON stroke_events(min_x, min_y, max_x, max_y) 
  WHERE event_type = 'stroke_created' AND min_x IS NOT NULL;

-- Показываем статистику
SELECT 
  COUNT(*) as total_strokes,
  COUNT(min_x) as strokes_with_bbox,
  COUNT(*) - COUNT(min_x) as strokes_without_bbox
FROM stroke_events
WHERE event_type = 'stroke_created';
