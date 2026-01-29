import request from 'supertest';

const mockQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ query: mockQuery })),
}));

const mockRedis = {
  connect: jest.fn().mockResolvedValue(undefined),
  isOpen: true,
  flushDb: jest.fn().mockResolvedValue(undefined),
};
jest.mock('redis', () => ({
  createClient: jest.fn(() => mockRedis),
}));

async function* emptyAsyncIter<T>(): AsyncGenerator<T> { }
const mockListObjects = jest.fn().mockReturnValue(emptyAsyncIter());
const mockRemoveObjects = jest.fn().mockResolvedValue(undefined);
jest.mock('minio', () => ({
  Client: jest.fn(() => ({
    listObjects: mockListObjects,
    removeObjects: mockRemoveObjects,
  })),
}));

import { app } from '../index';

const token = 'test-admin-token';

describe('admin-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /health', () => {
    it('returns ok and service name', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', service: 'admin-service' });
    });
  });

  describe('GET /', () => {
    it('returns service info and endpoints', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.service).toBe('admin-service');
      expect(res.body.status).toBe('running');
      expect(res.body.endpoints).toBeDefined();
    });
  });

  describe('requireAdmin middleware', () => {
    it('POST /admin/cleanup-old without token returns 401', async () => {
      const res = await request(app).post('/admin/cleanup-old').send({});
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('POST /admin/cleanup-old with x-admin-token passes', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const res = await request(app)
        .post('/admin/cleanup-old')
        .set('x-admin-token', token)
        .send({ days: 7 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('POST /admin/stats with query token passes', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ oldest: null }] })
        .mockResolvedValueOnce({ rows: [{ newest: null }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });
      const res = await request(app).get('/admin/stats').query({ token });
      expect(res.status).toBe(200);
      expect(res.body.events).toBeDefined();
    });
  });

  describe('POST /admin/cleanup-old', () => {
    it('deletes old events and returns count', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, stroke_id: 's1' }],
        rowCount: 1,
      });
      const res = await request(app)
        .post('/admin/cleanup-old')
        .set('x-admin-token', token)
        .send({ days: 3 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deletedEvents).toBe(1);
      expect(res.body.days).toBe(3);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM stroke_events'),
        expect.any(Array)
      );
    });
  });

  describe('POST /admin/cleanup-all', () => {
    it('returns success and counts', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 2 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      const res = await request(app)
        .post('/admin/cleanup-all')
        .set('x-admin-token', token);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deletedEvents).toBe(2);
      expect(res.body.deletedSnapshots).toBe(1);
    });
  });

  describe('GET /admin/stats', () => {
    it('returns events and snapshots stats', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [{ oldest: 1000 }] })
        .mockResolvedValueOnce({ rows: [{ newest: 2000 }] })
        .mockResolvedValueOnce({ rows: [{ count: '5' }] });
      const res = await request(app)
        .get('/admin/stats')
        .set('x-admin-token', token);
      expect(res.status).toBe(200);
      expect(res.body.events.total).toBe(10);
      expect(res.body.events.oldest).toBe(1000);
      expect(res.body.events.newest).toBe(2000);
      expect(res.body.snapshots.total).toBe(5);
    });
  });
});
