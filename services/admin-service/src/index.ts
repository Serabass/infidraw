import express from 'express';
import { Pool } from 'pg';
import { createClient } from 'redis';
import * as Minio from 'minio';

const app = express();
app.use(express.json({ limit: '10mb' }));

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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token-change-in-production';

// Middleware для проверки токена
const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// POST /admin/cleanup-old - удалить записи старше указанного периода
// Параметры: days (по умолчанию 7 дней = неделя)
app.post('/admin/cleanup-old', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.body.days || req.query.days as string || '7');
    const cutoffTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;

    const result = await pool.query(
      `DELETE FROM stroke_events 
       WHERE timestamp < $1 
       RETURNING id, stroke_id`,
      [cutoffTimestamp]
    );

    const deletedCount = result.rowCount || 0;
    const cutoffDate = new Date(cutoffTimestamp).toISOString();

    res.json({
      success: true,
      deletedEvents: deletedCount,
      cutoffTimestamp,
      cutoffDate,
      days,
      message: `Deleted ${deletedCount} events older than ${days} days (before ${cutoffDate})`,
    });
  } catch (error) {
    console.error('Error cleaning up old records:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/cleanup-all - очистить всё поле (удалить все strokes)
app.post('/admin/cleanup-all', requireAdmin, async (req, res) => {
  try {
    // Удаляем все события
    const eventsResult = await pool.query('DELETE FROM stroke_events RETURNING id');
    const deletedEvents = eventsResult.rowCount || 0;

    // Удаляем все снапшоты тайлов
    const snapshotsResult = await pool.query('DELETE FROM tile_snapshots RETURNING snapshot_url');
    const deletedSnapshots = snapshotsResult.rowCount || 0;

    // Удаляем все объекты из MinIO
    let deletedObjects = 0;
    try {
      const objects = minioClient.listObjects(BUCKET_NAME, '', true);
      const objectsToDelete: string[] = [];

      for await (const obj of objects) {
        if (obj.name) {
          objectsToDelete.push(obj.name);
        }
      }

      if (objectsToDelete.length > 0) {
        await minioClient.removeObjects(BUCKET_NAME, objectsToDelete);
        deletedObjects = objectsToDelete.length;
      }
    } catch (error) {
      console.error('Error deleting MinIO objects:', error);
    }

    // Очищаем Redis (опционально, если там что-то хранится)
    try {
      if (redisClient.isOpen) {
        await redisClient.flushDb();
      }
    } catch (error) {
      console.error('Error flushing Redis:', error);
    }

    res.json({
      success: true,
      deletedEvents,
      deletedSnapshots,
      deletedObjects,
      message: `Cleaned up everything: ${deletedEvents} events, ${deletedSnapshots} snapshots, ${deletedObjects} objects`,
    });
  } catch (error) {
    console.error('Error cleaning up all:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/stats - статистика для админа
app.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const totalEvents = await pool.query('SELECT COUNT(*) as count FROM stroke_events');
    const oldestEvent = await pool.query('SELECT MIN(timestamp) as oldest FROM stroke_events');
    const newestEvent = await pool.query('SELECT MAX(timestamp) as newest FROM stroke_events');
    const totalSnapshots = await pool.query('SELECT COUNT(*) as count FROM tile_snapshots');

    let minioObjectCount = 0;
    let minioTotalSize = 0;
    try {
      const objects = minioClient.listObjects(BUCKET_NAME, '', true);
      for await (const obj of objects) {
        if (obj.size) {
          minioObjectCount++;
          minioTotalSize += obj.size;
        }
      }
    } catch (error) {
      console.error('Error counting MinIO objects:', error);
    }

    res.json({
      events: {
        total: parseInt(totalEvents.rows[0].count),
        oldest: oldestEvent.rows[0].oldest ? parseInt(oldestEvent.rows[0].oldest) : null,
        newest: newestEvent.rows[0].newest ? parseInt(newestEvent.rows[0].newest) : null,
      },
      snapshots: {
        total: parseInt(totalSnapshots.rows[0].count),
        minioObjects: minioObjectCount,
        minioTotalSize,
      },
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'admin-service' });
});

// Корневой эндпоинт для проверки доступности
app.get('/', (req, res) => {
  res.json({
    service: 'admin-service',
    status: 'running',
    endpoints: {
      health: '/health',
      cleanupOld: '/admin/cleanup-old (POST, requires token)',
      cleanupAll: '/admin/cleanup-all (POST, requires token)',
      stats: '/admin/stats (GET, requires token)'
    }
  });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function start() {
  try {
    // Пытаемся подключиться к Redis, но не блокируем старт если не получилось
    try {
      await redisClient.connect();
      console.log('Redis connected');
    } catch (error) {
      console.warn('Failed to connect to Redis (will continue without it):', error);
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Admin Service running on port ${PORT}`);
      console.log(`Admin token: ${ADMIN_TOKEN}`);
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
