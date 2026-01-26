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

const wss = new WebSocketServer({ port: WS_PORT, path: '/ws' });

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

  const subscriber = redisClient.duplicate();
  await subscriber.connect();

  await subscriber.subscribe('stroke_events', (message) => {
    try {
      const event: StrokeEvent = JSON.parse(message);
      
      if (event.type === 'stroke_created' && event.stroke) {
        const tiles = getTilesForStroke(event.stroke);
        
        for (const [ws, client] of clients.entries()) {
          // Отправляем событие если клиент подписан на хотя бы один тайл, 
          // или если клиент не подписан ни на что (для совместимости)
          const shouldNotify = client.subscribedTiles.size === 0 || 
                              tiles.some((tile) => client.subscribedTiles.has(tile));
          
          if (shouldNotify && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event));
          }
        }
      }
    } catch (error) {
      console.error('Error processing stroke event:', error);
    }
  });
}

wss.on('connection', (ws: WebSocket) => {
  const client: Client = {
    ws,
    subscribedTiles: new Set(),
  };

  clients.set(ws, client);

  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'subscribe') {
        const { tiles } = message;
        if (Array.isArray(tiles)) {
          tiles.forEach((tile: string) => {
            client.subscribedTiles.add(tile);
          });
        }
      } else if (message.type === 'unsubscribe') {
        const { tiles } = message;
        if (Array.isArray(tiles)) {
          tiles.forEach((tile: string) => {
            client.subscribedTiles.delete(tile);
          });
        }
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
    }
  });

  ws.on('close', () => {
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
