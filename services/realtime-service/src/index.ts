import { decode as msgpackDecode } from '@msgpack/msgpack';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from 'redis';
import type { StrokeEvent } from './types';

function parseStrokeEventMessage(message: string | Buffer): StrokeEvent | null {
  try {
    if (Buffer.isBuffer(message)) {
      return msgpackDecode(new Uint8Array(message)) as StrokeEvent;
    }
    return JSON.parse(message as string) as StrokeEvent;
  } catch {
    return null;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = parseInt(process.env.WS_PORT || '3001');

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

const wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0', path: '/ws' });

interface Client {
  ws: WebSocket;
  subscribedTiles: Set<string>;
  roomId: string;
}

const clients = new Map<WebSocket, Client>();

function getTileKey(tileX: number, tileY: number): string {
  return `${tileX},${tileY}`;
}

function getTilesForStroke(stroke: any): string[] {
  const TILE_SIZE = 512;
  const tiles = new Set<string>();

  for (const [x, y] of stroke.points || []) {
    const tileX = Math.floor(x / TILE_SIZE);
    const tileY = Math.floor(y / TILE_SIZE);
    tiles.add(getTileKey(tileX, tileY));
  }

  return Array.from(tiles);
}

async function initRedis() {
  await redisClient.connect();
  console.log('[Redis] Connected to Redis');

  const subscriber = redisClient.duplicate();
  await subscriber.connect();
  console.log('[Redis] Subscriber connected');

  // В redis v4 подписка работает через обработчик сообщений
  // Сначала подписываемся, потом устанавливаем обработчик
  await subscriber.subscribe('stroke_events', (message, channel) => {
    try {
      const event = parseStrokeEventMessage(message);
      if (!event) {
        console.error('[Redis] Failed to decode stroke_events message');
        return;
      }
      console.log(`[Redis] Received stroke event: ${event.type}, strokeId: ${event.strokeId}`);

      const messageRoomId = String((event as any).roomId ?? '1');
      if (event.type === 'stroke_created' && event.stroke) {
        let notifiedCount = 0;
        for (const [ws, client] of clients.entries()) {
          const clientRoom = String(client.roomId ?? '1');
          if (clientRoom === messageRoomId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event));
            notifiedCount++;
          }
        }
        console.log(`[Redis] Notified ${notifiedCount} clients (room=${messageRoomId}) about stroke ${event.strokeId}`);
      } else if (event.type === 'stroke_erased') {
        let notifiedCount = 0;
        for (const [ws, client] of clients.entries()) {
          if (String(client.roomId ?? '1') === messageRoomId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event));
            notifiedCount++;
          }
        }
        console.log(`[Redis] Notified ${notifiedCount} clients (room=${messageRoomId}) about stroke_erased ${event.strokeId}`);
      }
    } catch (error) {
      console.error('Error processing stroke event:', error);
    }
  });

  await subscriber.subscribe('room_events', (message, channel) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'room_renamed' && data.roomId && typeof data.name === 'string') {
        const messageRoomId = String(data.roomId);
        let notifiedCount = 0;
        for (const [ws, client] of clients.entries()) {
          if (String(client.roomId ?? '1') === messageRoomId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
            notifiedCount++;
          }
        }
        console.log(`[Redis] Notified ${notifiedCount} clients (room=${messageRoomId}) about room_renamed -> "${data.name}"`);
      }
    } catch (error) {
      console.error('Error processing room event:', error);
    }
  });

  await subscriber.subscribe('talker_events', (message, channel) => {
    try {
      const data = JSON.parse(message);
      const messageRoomId = String(data.roomId ?? '1');
      if ((data.type === 'talker_created' && data.talker) || (data.type === 'talker_message' && data.message)) {
        let notifiedCount = 0;
        for (const [ws, client] of clients.entries()) {
          if (String(client.roomId ?? '1') === messageRoomId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
            notifiedCount++;
          }
        }
        console.log(`[Redis] Notified ${notifiedCount} clients (room=${messageRoomId}) about ${data.type}`);
      }
    } catch (error) {
      console.error('Error processing talker event:', error);
    }
  });

  console.log('[Redis] Subscribed to stroke_events, room_events and talker_events channels');
}

wss.on('connection', (ws: WebSocket, req: { url?: string }) => {
  console.log(`[WS] New client connected, total: ${clients.size + 1}`);
  let roomIdFromUrl = '1';
  if (req.url) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('roomId');
      if (q) roomIdFromUrl = q;
    } catch {
      // ignore parse error
    }
  }
  const client: Client = {
    ws,
    subscribedTiles: new Set(),
    roomId: roomIdFromUrl,
  };

  clients.set(ws, client);
  console.log(`[WS] Client room from URL: ${client.roomId}`);

  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[WS] Received message from client: ${message.type}`);

      if (message.type === 'subscribe') {
        if (typeof message.roomId === 'string') {
          client.roomId = message.roomId;
          console.log(`[WS] Client room: ${client.roomId}`);
        }
        const { tiles } = message;
        if (Array.isArray(tiles)) {
          tiles.forEach((tile: string) => {
            client.subscribedTiles.add(tile);
          });
          console.log(`[WS] Client subscribed to ${tiles.length} tiles: ${tiles.join(', ')}`);
        }
      } else if (message.type === 'unsubscribe') {
        const { tiles } = message;
        if (Array.isArray(tiles)) {
          tiles.forEach((tile: string) => {
            client.subscribedTiles.delete(tile);
          });
          console.log(`[WS] Client unsubscribed from ${tiles.length} tiles`);
        }
      } else if (message.type === 'stroke_created' && message.stroke && typeof message.roomId === 'string') {
        const roomId = String(message.roomId);
        const payload = JSON.stringify({ type: 'stroke_created', stroke: message.stroke, roomId });
        let count = 0;
        for (const [sock, c] of clients.entries()) {
          if (String(c.roomId ?? '1') === roomId && sock.readyState === WebSocket.OPEN) {
            sock.send(payload);
            count++;
          }
        }
        console.log(`[WS] Broadcast stroke_created ${message.stroke?.id ?? '?'} to ${count} clients (room=${roomId})`);
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected, remaining: ${clients.size - 1}`);
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', clients: clients.size });
});

async function start() {
  try {
    await initRedis();
    app.listen(PORT, () => {
      console.log(`Realtime Service running on port ${PORT}`);
      console.log(`WebSocket server running on port ${WS_PORT}`);
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
