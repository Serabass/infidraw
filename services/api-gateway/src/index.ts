import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import rateLimit from 'express-rate-limit';
import { createClient } from 'redis';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: {
    async incr(key: string, cb: (err?: Error, hits?: number, resetTime?: Date) => void) {
      try {
        const count = await redisClient.incr(key);
        await redisClient.expire(key, 60);
        cb(undefined, count, new Date(Date.now() + 60000));
      } catch (err) {
        cb(err as Error);
      }
    },
    async decrement(key: string) {
      await redisClient.decr(key);
    },
    async resetKey(key: string) {
      await redisClient.del(key);
    },
  } as any,
});

app.use('/api', limiter);

app.use(
  '/api/strokes',
  createProxyMiddleware({
    target: process.env.EVENT_STORE_URL || 'http://event-store:3000',
    changeOrigin: true,
    pathRewrite: {
      '^/api/strokes': '/strokes',
    },
  })
);

app.use(
  '/api/events',
  createProxyMiddleware({
    target: process.env.EVENT_STORE_URL || 'http://event-store:3000',
    changeOrigin: true,
    pathRewrite: {
      '^/api/events': '/events',
    },
  })
);

app.use(
  '/api/rooms',
  createProxyMiddleware({
    target: process.env.EVENT_STORE_URL || 'http://event-store:3000',
    changeOrigin: true,
    pathRewrite: {
      '^/api/rooms': '/rooms',
    },
  })
);

app.use(
  '/api/tiles',
  createProxyMiddleware({
    target: process.env.TILE_SERVICE_URL || 'http://tile-service:3000',
    changeOrigin: true,
    pathRewrite: {
      '^/api/tiles': '/tiles',
    },
  })
);

app.use(
  '/api/talkers',
  createProxyMiddleware({
    target: process.env.EVENT_STORE_URL || 'http://event-store:3000',
    changeOrigin: true,
    pathRewrite: {
      '^/api/talkers': '/talkers',
    },
  })
);

app.use(
  '/api/metrics',
  createProxyMiddleware({
    target: process.env.METRICS_SERVICE_URL || 'http://metrics-service:3000',
    changeOrigin: true,
    pathRewrite: {
      '^/api/metrics': '/metrics',
    },
  })
);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    services: ['event-store', 'tile-service', 'realtime-service', 'metrics-service']
  });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function start() {
  try {
    await redisClient.connect();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`API Gateway running on port ${PORT}`);
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
