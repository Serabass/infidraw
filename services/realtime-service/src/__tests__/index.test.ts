import request from 'supertest';

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    duplicate: jest.fn().mockResolvedValue({
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
    }),
  })),
}));

import { app } from '../index';

describe('realtime-service', () => {
  describe('GET /health', () => {
    it('returns ok and client count', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.clients).toBe('number');
    });
  });
});
