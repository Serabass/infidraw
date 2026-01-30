import request from 'supertest';

const mockQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ query: mockQuery })),
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockPutObject = jest.fn().mockResolvedValue(undefined);
const mockGetObject = jest.fn();
const mockBucketExists = jest.fn().mockResolvedValue(true);
jest.mock('minio', () => ({
  Client: jest.fn(() => ({
    putObject: mockPutObject,
    getObject: mockGetObject,
    bucketExists: mockBucketExists,
  })),
}));

const mockToBuffer = jest.fn().mockResolvedValue(Buffer.from('png'));
const mockCtx = {
  fillStyle: '',
  fillRect: jest.fn(),
  strokeStyle: '',
  lineWidth: 0,
  lineCap: 'round',
  lineJoin: 'round',
  globalAlpha: 1,
  globalCompositeOperation: 'source-over',
  setLineDash: jest.fn(),
  beginPath: jest.fn(),
  moveTo: jest.fn(),
  lineTo: jest.fn(),
  stroke: jest.fn(),
};
const mockGetContext = jest.fn(() => mockCtx);
jest.mock('canvas', () => ({
  createCanvas: jest.fn(() => ({
    getContext: mockGetContext,
    toBuffer: mockToBuffer,
  })),
}));

import { app } from '../index';

describe('tile-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /tiles', () => {
    it('returns 400 for invalid coordinates', async () => {
      const res = await request(app).get('/tiles').query({ x1: 'x', y1: 0, x2: 512, y2: 512 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid coordinates');
    });

    it('returns tiles array for valid bbox (no snapshots, no strokes)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      const res = await request(app).get('/tiles').query({ roomId: '1', x1: 0, y1: 0, x2: 512, y2: 512 });
      expect(res.status).toBe(200);
      expect(res.body.tiles).toBeDefined();
      expect(Array.isArray(res.body.tiles)).toBe(true);
      expect(res.body.tiles.length).toBeGreaterThan(0);
      const tile = res.body.tiles[0];
      expect(tile.tileX).toBeDefined();
      expect(tile.tileY).toBeDefined();
      expect(tile.version).toBeDefined();
      expect(tile.strokes).toEqual([]);
    });

    it('returns tiles with snapshot when snapshot exists', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ snapshot_url: '/snapshots/room_1/tile_0_0_123.png', version: 123 }],
      });
      const res = await request(app).get('/tiles').query({ roomId: '1', x1: 0, y1: 0, x2: 512, y2: 512 });
      expect(res.status).toBe(200);
      expect(res.body.tiles[0].snapshotUrl).toBe('/snapshots/room_1/tile_0_0_123.png');
      expect(res.body.tiles[0].version).toBe(123);
    });
  });

  describe('GET /snapshots/:key', () => {
    it('returns 404 when snapshot not found', async () => {
      const err = new Error('NoSuchKey') as Error & { code?: string };
      err.code = 'NoSuchKey';
      mockGetObject.mockRejectedValueOnce(err);
      const res = await request(app).get('/snapshots/room_1/tile_0_0_missing.png');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Snapshot not found');
    });
  });
});
