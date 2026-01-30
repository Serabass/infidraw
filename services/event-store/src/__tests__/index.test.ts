import request from 'supertest';

const mockQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: mockQuery,
    connect: jest.fn(() => Promise.resolve({ query: mockQuery, release: jest.fn() })),
  })),
}));

const mockPublish = jest.fn().mockResolvedValue(undefined);
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: mockPublish,
  })),
}));

import { app } from '../index';

const validStroke = {
  tool: 'pen' as const,
  color: '#000000',
  width: 2,
  points: [
    [0, 0],
    [100, 100],
  ],
};

describe('event-store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /strokes', () => {
    it('returns 400 for invalid body (missing tool)', async () => {
      const res = await request(app)
        .post('/strokes')
        .send({ color: '#000', width: 2, points: [[0, 0]] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid stroke data');
    });

    it('returns 400 for invalid tool', async () => {
      const res = await request(app)
        .post('/strokes')
        .send({ tool: 'invalid', color: '#000', width: 2, points: [[0, 0]] });
      expect(res.status).toBe(400);
    });

    it('creates stroke and returns 201', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 1 });
      const res = await request(app).post('/strokes').send(validStroke);
      expect(res.status).toBe(201);
      expect(res.body.strokeId).toBeDefined();
      expect(res.body.stroke.tool).toBe('pen');
      expect(res.body.stroke.points).toEqual(validStroke.points);
      expect(mockPublish).toHaveBeenCalledWith('stroke_events', expect.stringContaining('stroke_created'));
    });
  });

  describe('GET /strokes/:id', () => {
    it('returns 404 when stroke not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).get('/strokes/non-existent-id');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Stroke not found');
    });

    it('returns stroke data when found', async () => {
      const strokeData = { id: 's1', tool: 'pen', points: [[0, 0]] };
      mockQuery.mockResolvedValueOnce({ rows: [{ stroke_data: strokeData }] });
      const res = await request(app).get('/strokes/s1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(strokeData);
    });
  });

  describe('GET /events', () => {
    it('returns events and roomName', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              event_type: 'stroke_created',
              stroke_id: 's1',
              stroke_data: { id: 's1', tool: 'pen' },
              timestamp: 1000,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });
      const res = await request(app).get('/events').query({ roomId: '1' });
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0].type).toBe('stroke_created');
      expect(res.body.roomId).toBe('1');
      expect(res.body.roomName).toBeDefined();
    });
  });

  describe('POST /strokes/:id/erase', () => {
    it('returns 400 for invalid body', async () => {
      const res = await request(app).post('/strokes/s1/erase').send({});
      expect(res.status).toBe(400);
    });

    it('publishes erase event and returns 201', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ min_x: 0, min_y: 0, max_x: 100, max_y: 100 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      const res = await request(app)
        .post('/strokes/s1/erase')
        .send({ hiddenPointIndices: [0, 1] });
      expect(res.status).toBe(201);
      expect(res.body.strokeId).toBe('s1');
      expect(res.body.hiddenPointIndices).toEqual([0, 1]);
      expect(mockPublish).toHaveBeenCalledWith('stroke_events', expect.stringContaining('stroke_erased'));
    });
  });

  describe('GET /rooms', () => {
    it('returns list of rooms from DB and stroke_events', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { room_id: '1', name: 'First', updated_at: '2000' },
            { room_id: '2', name: 'Second', updated_at: '1000' },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ room_id: '1' }, { room_id: '2' }, { room_id: '3' }],
        });
      const res = await request(app).get('/rooms');
      expect(res.status).toBe(200);
      expect(res.body.rooms).toBeDefined();
      expect(res.body.rooms.length).toBe(3);
      expect(res.body.rooms[0].roomId).toBe('1');
      expect(res.body.rooms[0].name).toBe('First');
      expect(res.body.rooms.find((r: { roomId: string }) => r.roomId === '3').name).toBe('Room 3');
    });
  });

  describe('GET /rooms/:roomId', () => {
    it('returns default room when not in DB', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).get('/rooms/1');
      expect(res.status).toBe(200);
      expect(res.body.roomId).toBe('1');
      expect(res.body.name).toBe('Room 1');
      expect(res.body.updatedAt).toBe(0);
    });

    it('returns room from DB', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ room_id: '1', name: 'My Room', updated_at: 12345 }],
      });
      const res = await request(app).get('/rooms/1');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('My Room');
      expect(res.body.updatedAt).toBe(12345);
    });
  });

  describe('GET /rooms/:roomId/rename', () => {
    it('returns 400 when name is empty', async () => {
      const res = await request(app).get('/rooms/1/rename').query({ name: '   ' });
      expect(res.status).toBe(400);
    });

    it('updates room name and publishes event', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).get('/rooms/1/rename').query({ name: 'New Name' });
      expect(res.status).toBe(200);
      expect(res.body.roomId).toBe('1');
      expect(res.body.name).toBe('New Name');
      expect(mockPublish).toHaveBeenCalledWith('room_events', expect.stringContaining('room_renamed'));
    });
  });

  describe('PUT /rooms/:roomId', () => {
    it('returns 400 for invalid name', async () => {
      const res = await request(app).put('/rooms/1').send({ name: '' });
      expect(res.status).toBe(400);
    });

    it('updates room name', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).put('/rooms/1').send({ name: 'Updated' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated');
    });
  });
});
