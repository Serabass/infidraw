import request from 'supertest';

const mockIncr = jest.fn().mockImplementation((key, cb) => {
  cb(undefined, 1, new Date(Date.now() + 60000));
});
const mockExpire = jest.fn().mockResolvedValue(undefined);
const mockDecr = jest.fn().mockResolvedValue(undefined);
const mockDel = jest.fn().mockResolvedValue(undefined);

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    incr: mockIncr,
    expire: mockExpire,
    decr: mockDecr,
    del: mockDel,
  })),
}));

import { app } from '../index';

describe('api-gateway', () => {
  describe('GET /health', () => {
    it('returns ok and list of services', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.services).toContain('event-store');
      expect(res.body.services).toContain('tile-service');
      expect(res.body.services).toContain('metrics-service');
    });
  });
});
