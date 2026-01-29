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

interface DatabaseMetrics {
  databaseSize: number;
  tableSize: number;
  eventCount: number;
  oldestEvent: number | null;
  newestEvent: number | null;
}

interface MinIOMetrics {
  bucketSize: number;
  objectCount: number;
  averageObjectSize: number;
}

interface RedisMetrics {
  usedMemory: number;
  usedMemoryHuman: string;
  connectedClients: number;
}

interface SystemMetrics {
  postgres: DatabaseMetrics;
  minio: MinIOMetrics;
  redis: RedisMetrics;
  totalSize: number;
  timestamp: number;
}

async function getPostgresMetrics(): Promise<DatabaseMetrics> {
  try {
    const dbSizeResult = await pool.query(
      `SELECT pg_size_pretty(pg_database_size('infidraw')) as size,
              pg_database_size('infidraw') as size_bytes`
    );
    const dbSizeBytes = parseInt(dbSizeResult.rows[0].size_bytes);

    const tableSizeResult = await pool.query(
      `SELECT pg_size_pretty(pg_total_relation_size('stroke_events')) as size,
              pg_total_relation_size('stroke_events') as size_bytes`
    );
    const tableSizeBytes = parseInt(tableSizeResult.rows[0].size_bytes);

    const countResult = await pool.query(
      `SELECT COUNT(*) as count, 
              MIN(timestamp) as oldest, 
              MAX(timestamp) as newest 
       FROM stroke_events`
    );

    return {
      databaseSize: dbSizeBytes,
      tableSize: tableSizeBytes,
      eventCount: parseInt(countResult.rows[0].count),
      oldestEvent: countResult.rows[0].oldest ? parseInt(countResult.rows[0].oldest) : null,
      newestEvent: countResult.rows[0].newest ? parseInt(countResult.rows[0].newest) : null,
    };
  } catch (error) {
    console.error('Error fetching PostgreSQL metrics:', error);
    throw error;
  }
}

async function getMinIOMetrics(): Promise<MinIOMetrics> {
  try {
    let totalSize = 0;
    let objectCount = 0;

    const objects = minioClient.listObjects(BUCKET_NAME, '', true);

    for await (const obj of objects) {
      if (obj.size) {
        totalSize += obj.size;
        objectCount++;
      }
    }

    return {
      bucketSize: totalSize,
      objectCount,
      averageObjectSize: objectCount > 0 ? totalSize / objectCount : 0,
    };
  } catch (error) {
    console.error('Error fetching MinIO metrics:', error);
    throw error;
  }
}

async function getRedisMetrics(): Promise<RedisMetrics> {
  try {
    const info = await redisClient.info('memory');
    const clientsInfo = await redisClient.info('clients');

    const memoryLines = info.split('\r\n');
    const clientsLines = clientsInfo.split('\r\n');

    let usedMemory = 0;
    let usedMemoryHuman = '0B';
    let connectedClients = 0;

    for (const line of memoryLines) {
      if (line.startsWith('used_memory:')) {
        usedMemory = parseInt(line.split(':')[1]);
      } else if (line.startsWith('used_memory_human:')) {
        usedMemoryHuman = line.split(':')[1];
      }
    }

    for (const line of clientsLines) {
      if (line.startsWith('connected_clients:')) {
        connectedClients = parseInt(line.split(':')[1]);
      }
    }

    return {
      usedMemory,
      usedMemoryHuman,
      connectedClients,
    };
  } catch (error) {
    console.error('Error fetching Redis metrics:', error);
    throw error;
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// GET /metrics - получить все метрики (JSON или Prometheus формат)
app.get('/metrics', async (req, res) => {
  try {
    const [postgres, minio, redis] = await Promise.all([
      getPostgresMetrics(),
      getMinIOMetrics(),
      getRedisMetrics(),
    ]);

    // Если запрашивают Prometheus формат
    if (req.query.format === 'prometheus' || req.headers.accept?.includes('text/plain')) {
      const totalSize = postgres.databaseSize + minio.bucketSize + redis.usedMemory;
      const timestamp = Date.now() / 1000;

      let prometheusMetrics = `# HELP infidraw_postgres_database_size_bytes PostgreSQL database size in bytes
# TYPE infidraw_postgres_database_size_bytes gauge
infidraw_postgres_database_size_bytes ${postgres.databaseSize}

# HELP infidraw_postgres_table_size_bytes PostgreSQL stroke_events table size in bytes
# TYPE infidraw_postgres_table_size_bytes gauge
infidraw_postgres_table_size_bytes ${postgres.tableSize}

# HELP infidraw_postgres_events_total Total number of stroke events in PostgreSQL
# TYPE infidraw_postgres_events_total counter
infidraw_postgres_events_total ${postgres.eventCount}

# HELP infidraw_postgres_oldest_event_timestamp Timestamp of the oldest event in PostgreSQL
# TYPE infidraw_postgres_oldest_event_timestamp gauge
infidraw_postgres_oldest_event_timestamp ${postgres.oldestEvent ? postgres.oldestEvent / 1000 : 0}

# HELP infidraw_postgres_newest_event_timestamp Timestamp of the newest event in PostgreSQL
# TYPE infidraw_postgres_newest_event_timestamp gauge
infidraw_postgres_newest_event_timestamp ${postgres.newestEvent ? postgres.newestEvent / 1000 : 0}

# HELP infidraw_minio_bucket_size_bytes MinIO bucket size in bytes
# TYPE infidraw_minio_bucket_size_bytes gauge
infidraw_minio_bucket_size_bytes ${minio.bucketSize}

# HELP infidraw_minio_objects_total Total number of objects in MinIO bucket
# TYPE infidraw_minio_objects_total counter
infidraw_minio_objects_total ${minio.objectCount}

# HELP infidraw_minio_average_object_size_bytes Average object size in MinIO bucket
# TYPE infidraw_minio_average_object_size_bytes gauge
infidraw_minio_average_object_size_bytes ${minio.averageObjectSize}

# HELP infidraw_redis_memory_bytes Redis used memory in bytes
# TYPE infidraw_redis_memory_bytes gauge
infidraw_redis_memory_bytes ${redis.usedMemory}

# HELP infidraw_redis_connected_clients Number of connected Redis clients
# TYPE infidraw_redis_connected_clients gauge
infidraw_redis_connected_clients ${redis.connectedClients}

# HELP infidraw_total_size_bytes Total storage size across all services in bytes
# TYPE infidraw_total_size_bytes gauge
infidraw_total_size_bytes ${totalSize}

# HELP infidraw_metrics_scrape_timestamp Timestamp when metrics were scraped
# TYPE infidraw_metrics_scrape_timestamp gauge
infidraw_metrics_scrape_timestamp ${timestamp}
`;

      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      return res.send(prometheusMetrics);
    }

    // По умолчанию возвращаем JSON
    const totalSize = postgres.databaseSize + minio.bucketSize + redis.usedMemory;

    const metrics: SystemMetrics = {
      postgres: {
        ...postgres,
        databaseSize: postgres.databaseSize,
        tableSize: postgres.tableSize,
      },
      minio: {
        ...minio,
        bucketSize: minio.bucketSize,
      },
      redis: {
        ...redis,
        usedMemory: redis.usedMemory,
      },
      totalSize,
      timestamp: Date.now(),
    };

    res.json(metrics);
  } catch (error) {
    console.error('Error fetching metrics:', error);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// GET /metrics/summary - краткая сводка
app.get('/metrics/summary', async (req, res) => {
  try {
    const [postgres, minio, redis] = await Promise.all([
      getPostgresMetrics(),
      getMinIOMetrics(),
      getRedisMetrics(),
    ]);

    const totalSize = postgres.databaseSize + minio.bucketSize + redis.usedMemory;

    res.json({
      totalSize,
      totalSizeFormatted: formatBytes(totalSize),
      breakdown: {
        postgres: {
          size: postgres.databaseSize,
          sizeFormatted: formatBytes(postgres.databaseSize),
          events: postgres.eventCount,
        },
        minio: {
          size: minio.bucketSize,
          sizeFormatted: formatBytes(minio.bucketSize),
          objects: minio.objectCount,
        },
        redis: {
          size: redis.usedMemory,
          sizeFormatted: redis.usedMemoryHuman,
          clients: redis.connectedClients,
        },
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error fetching metrics summary:', error);
    res.status(500).json({ error: 'Failed to fetch metrics summary' });
  }
});

// GET /metrics/postgres - только PostgreSQL метрики
app.get('/metrics/postgres', async (req, res) => {
  try {
    const metrics = await getPostgresMetrics();
    res.json({
      ...metrics,
      databaseSizeFormatted: formatBytes(metrics.databaseSize),
      tableSizeFormatted: formatBytes(metrics.tableSize),
    });
  } catch (error) {
    console.error('Error fetching PostgreSQL metrics:', error);
    res.status(500).json({ error: 'Failed to fetch PostgreSQL metrics' });
  }
});

// GET /metrics/minio - только MinIO метрики
app.get('/metrics/minio', async (req, res) => {
  try {
    const metrics = await getMinIOMetrics();
    res.json({
      ...metrics,
      bucketSizeFormatted: formatBytes(metrics.bucketSize),
      averageObjectSizeFormatted: formatBytes(metrics.averageObjectSize),
    });
  } catch (error) {
    console.error('Error fetching MinIO metrics:', error);
    res.status(500).json({ error: 'Failed to fetch MinIO metrics' });
  }
});

// GET /metrics/redis - только Redis метрики
app.get('/metrics/redis', async (req, res) => {
  try {
    const metrics = await getRedisMetrics();
    res.json({
      ...metrics,
      usedMemoryFormatted: formatBytes(metrics.usedMemory),
    });
  } catch (error) {
    console.error('Error fetching Redis metrics:', error);
    res.status(500).json({ error: 'Failed to fetch Redis metrics' });
  }
});

// GET /metrics/prometheus - метрики в формате Prometheus
app.get('/metrics/prometheus', async (req, res) => {
  try {
    const [postgres, minio, redis] = await Promise.all([
      getPostgresMetrics(),
      getMinIOMetrics(),
      getRedisMetrics(),
    ]);

    const totalSize = postgres.databaseSize + minio.bucketSize + redis.usedMemory;
    const timestamp = Date.now() / 1000; // Prometheus использует секунды

    // Формируем метрики в формате Prometheus
    let prometheusMetrics = `# HELP infidraw_postgres_database_size_bytes PostgreSQL database size in bytes
# TYPE infidraw_postgres_database_size_bytes gauge
infidraw_postgres_database_size_bytes ${postgres.databaseSize}

# HELP infidraw_postgres_table_size_bytes PostgreSQL stroke_events table size in bytes
# TYPE infidraw_postgres_table_size_bytes gauge
infidraw_postgres_table_size_bytes ${postgres.tableSize}

# HELP infidraw_postgres_events_total Total number of stroke events in PostgreSQL
# TYPE infidraw_postgres_events_total counter
infidraw_postgres_events_total ${postgres.eventCount}

# HELP infidraw_postgres_oldest_event_timestamp Timestamp of the oldest event in PostgreSQL
# TYPE infidraw_postgres_oldest_event_timestamp gauge
infidraw_postgres_oldest_event_timestamp ${postgres.oldestEvent ? postgres.oldestEvent / 1000 : 0}

# HELP infidraw_postgres_newest_event_timestamp Timestamp of the newest event in PostgreSQL
# TYPE infidraw_postgres_newest_event_timestamp gauge
infidraw_postgres_newest_event_timestamp ${postgres.newestEvent ? postgres.newestEvent / 1000 : 0}

# HELP infidraw_minio_bucket_size_bytes MinIO bucket size in bytes
# TYPE infidraw_minio_bucket_size_bytes gauge
infidraw_minio_bucket_size_bytes ${minio.bucketSize}

# HELP infidraw_minio_objects_total Total number of objects in MinIO bucket
# TYPE infidraw_minio_objects_total counter
infidraw_minio_objects_total ${minio.objectCount}

# HELP infidraw_minio_average_object_size_bytes Average object size in MinIO bucket
# TYPE infidraw_minio_average_object_size_bytes gauge
infidraw_minio_average_object_size_bytes ${minio.averageObjectSize}

# HELP infidraw_redis_memory_bytes Redis used memory in bytes
# TYPE infidraw_redis_memory_bytes gauge
infidraw_redis_memory_bytes ${redis.usedMemory}

# HELP infidraw_redis_connected_clients Number of connected Redis clients
# TYPE infidraw_redis_connected_clients gauge
infidraw_redis_connected_clients ${redis.connectedClients}

# HELP infidraw_total_size_bytes Total storage size across all services in bytes
# TYPE infidraw_total_size_bytes gauge
infidraw_total_size_bytes ${totalSize}

# HELP infidraw_metrics_scrape_timestamp Timestamp when metrics were scraped
# TYPE infidraw_metrics_scrape_timestamp gauge
infidraw_metrics_scrape_timestamp ${timestamp}
`;

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(prometheusMetrics);
  } catch (error) {
    console.error('Error fetching Prometheus metrics:', error);
    res.status(500).send('# Error fetching metrics\n');
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await redisClient.connect();
    app.listen(PORT, () => {
      console.log(`Metrics Service running on port ${PORT}`);
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
