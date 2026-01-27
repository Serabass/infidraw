import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from 'redis';
import type { StrokeEvent } from './types';

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
      const event: StrokeEvent = JSON.parse(message);
      console.log(`[Redis] Received stroke event: ${event.type}, strokeId: ${event.strokeId}`);
      
      if (event.type === 'stroke_created' && event.stroke) {
        const tiles = getTilesForStroke(event.stroke);
        console.log(`[Redis] Stroke affects tiles: ${tiles.join(', ')}, total clients: ${clients.size}`);
        
        let notifiedCount = 0;
        for (const [ws, client] of clients.entries()) {
          // Отправляем событие если клиент подписан на хотя бы один тайл, 
          // или если клиент не подписан ни на что (для совместимости)
          const shouldNotify = client.subscribedTiles.size === 0 || 
                              tiles.some((tile) => client.subscribedTiles.has(tile));
          
          if (shouldNotify && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event));
            notifiedCount++;
          }
        }
        console.log(`[Redis] Notified ${notifiedCount} clients about stroke ${event.strokeId}`);
      }
    } catch (error) {
      console.error('Error processing stroke event:', error);
    }
  });
  
  console.log('[Redis] Subscribed to stroke_events channel');
}

wss.on('connection', (ws: WebSocket) => {
  console.log(`[WS] New client connected, total: ${clients.size + 1}`);
  const client: Client = {
    ws,
    subscribedTiles: new Set(),
  };

  clients.set(ws, client);

  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[WS] Received message from client: ${message.type}`);

      if (message.type === 'subscribe') {
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

start();
