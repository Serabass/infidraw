import request from 'supertest';

const mockQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ query: mockQuery })),
}));

const mockInfo = jest.fn();
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    info: mockInfo,
  })),
}));

async function* emptyAsyncIter<T>(): AsyncGenerator<T> { }
const mockListObjects = jest.fn().mockReturnValue(emptyAsyncIter());
jest.mock('minio', () => ({
  Client: jest.fn(() => ({
    listObjects: mockListObjects,
  })),
}));

import { app } from '../index';

describe('metrics-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('pg_database_size') && sql.includes('infidraw'))
        return Promise.resolve({ rows: [{ size: '10 MB', size_bytes: 10485760 }] });
      if (sql.includes('pg_total_relation_size'))
        return Promise.resolve({ rows: [{ size: '5 MB', size_bytes: 5242880 }] });
      if (sql.includes('COUNT(*)') && sql.includes('stroke_events'))
        return Promise.resolve({ rows: [{ count: '100', oldest: 1000, newest: 2000 }] });
      return Promise.resolve({ rows: [] });
    });
    mockInfo.mockImplementation((section: string) => {
      if (section === 'memory')
        return Promise.resolve('used_memory:1024\r\nused_memory_human:1K\r\n');
      if (section === 'clients')
        return Promise.resolve('connected_clients:2\r\n');
      return Promise.resolve('');
    });
  });

  describe('GET /health', () => {
    it('returns ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /metrics', () => {
    it('returns JSON metrics by default', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.body.postgres).toBeDefined();
      expect(res.body.postgres.databaseSize).toBe(10485760);
      expect(res.body.postgres.eventCount).toBe(100);
      expect(res.body.minio).toBeDefined();
      expect(res.body.redis).toBeDefined();
      expect(res.body.totalSize).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    it('returns Prometheus format when format=prometheus', async () => {
      const res = await request(app).get('/metrics').query({ format: 'prometheus' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('infidraw_postgres_database_size_bytes');
      expect(res.text).toContain('infidraw_redis_memory_bytes');
    });
  });

  describe('GET /metrics/summary', () => {
    it('returns summary with formatted sizes', async () => {
      const res = await request(app).get('/metrics/summary');
      expect(res.status).toBe(200);
      expect(res.body.totalSize).toBeDefined();
      expect(res.body.totalSizeFormatted).toBeDefined();
      expect(res.body.breakdown.postgres).toBeDefined();
      expect(res.body.breakdown.minio).toBeDefined();
      expect(res.body.breakdown.redis).toBeDefined();
    });
  });

  describe('GET /metrics/postgres', () => {
    it('returns postgres metrics only', async () => {
      const res = await request(app).get('/metrics/postgres');
      expect(res.status).toBe(200);
      expect(res.body.databaseSize).toBe(10485760);
      expect(res.body.databaseSizeFormatted).toBeDefined();
    });
  });

  describe('GET /metrics/minio', () => {
    it('returns minio metrics only', async () => {
      const res = await request(app).get('/metrics/minio');
      expect(res.status).toBe(200);
      expect(res.body.bucketSize).toBeDefined();
      expect(res.body.objectCount).toBeDefined();
    });
  });

  describe('GET /metrics/redis', () => {
    it('returns redis metrics only', async () => {
      const res = await request(app).get('/metrics/redis');
      expect(res.status).toBe(200);
      expect(res.body.usedMemory).toBe(1024);
      expect(res.body.usedMemoryHuman).toBe('1K');
      expect(res.body.connectedClients).toBe(2);
    });
  });

  describe('GET /metrics/prometheus', () => {
    it('returns Prometheus text format', async () => {
      const res = await request(app).get('/metrics/prometheus');
      expect(res.status).toBe(200);
      expect(res.text).toContain('# TYPE infidraw_postgres_database_size_bytes gauge');
    });
  });
});
