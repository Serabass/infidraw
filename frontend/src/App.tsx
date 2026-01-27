import React, { useRef, useEffect, useState } from 'react';
import { Stage, Layer, Line, Rect } from 'react-konva';
import type { Stroke, TileResponse, BrushType } from './types';

const API_URL = import.meta.env.VITE_API_URL || '/api';
const WS_URL = (() => {
  const envUrl = import.meta.env.VITE_WS_URL;
  if (envUrl) return envUrl;
  // Определяем протокол WebSocket на основе текущего протокола страницы
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
})();
const TILE_SIZE = 512;

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

function App() {
  const stageRef = useRef<any>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [currentStroke, setCurrentStroke] = useState<number[]>([]);
  const [color, setColor] = useState('#000000');
  const [width, setWidth] = useState(3);
  const [brush, setBrush] = useState<'pen' | 'brush' | 'marker' | 'highlighter' | 'eraser' | 'pencil' | 'chalk'>('pen');
  const wsRef = useRef<WebSocket | null>(null);
  const [tiles, setTiles] = useState<Map<string, TileResponse>>(new Map());

  const subscribeToVisibleTiles = (ws: WebSocket) => {
    if (!stageRef.current || ws.readyState !== WebSocket.OPEN) return;

    const stage = stageRef.current.getStage();
    if (!stage) return;

    const stageWidth = stage.width();
    const stageHeight = stage.height();

    const worldX1 = (-camera.x) / camera.zoom;
    const worldY1 = (-camera.y) / camera.zoom;
    const worldX2 = (stageWidth - camera.x) / camera.zoom;
    const worldY2 = (stageHeight - camera.y) / camera.zoom;

    const minTileX = Math.floor(worldX1 / TILE_SIZE);
    const minTileY = Math.floor(worldY1 / TILE_SIZE);
    const maxTileX = Math.floor(worldX2 / TILE_SIZE);
    const maxTileY = Math.floor(worldY2 / TILE_SIZE);

    const visibleTiles: string[] = [];
    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
      for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
        visibleTiles.push(`${tileX},${tileY}`);
      }
    }

    if (visibleTiles.length > 0) {
      ws.send(JSON.stringify({
        type: 'subscribe',
        tiles: visibleTiles,
      }));
      console.log('Subscribed to tiles:', visibleTiles.length);
    }
  };

  useEffect(() => {
    let reconnectTimeout: NodeJS.Timeout;
    let ws: WebSocket | null = null;

    const connect = () => {
      try {
        ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log('WebSocket connected to', WS_URL);
          // Подписываемся на тайлы при подключении (с небольшой задержкой для инициализации stage)
          setTimeout(() => {
            subscribeToVisibleTiles(ws);
          }, 100);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'stroke_created' && data.stroke) {
              console.log(`[Frontend] Received stroke via WebSocket: ${data.strokeId}`, data.stroke);
              setStrokes((prev) => {
                // Проверяем, нет ли уже такого stroke (избегаем дубликатов)
                const exists = prev.some(s => s.id === data.stroke.id);
                if (exists) {
                  console.log(`[Frontend] Stroke ${data.stroke.id} already exists, skipping`);
                  return prev;
                }
                return [...prev, data.stroke];
              });
            }
          } catch (error) {
            console.error('[Frontend] Error parsing WebSocket message:', error);
          }
        };

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
        };

        ws.onclose = (event) => {
          console.log('WebSocket closed', event.code, event.reason);
          if (event.code !== 1000) {
            reconnectTimeout = setTimeout(() => {
              console.log('Reconnecting WebSocket...');
              connect();
            }, 3000);
          }
        };
      } catch (error) {
        console.error('Failed to create WebSocket:', error);
        reconnectTimeout = setTimeout(() => {
          console.log('Retrying WebSocket connection...');
          connect();
        }, 3000);
      }
    };

    connect();

    return () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (ws) {
        ws.close(1000, 'Component unmounting');
      }
    };
  }, []);

  const loadTiles = async () => {
    if (!stageRef.current) return;

    const stage = stageRef.current.getStage();
    const stageWidth = stage.width();
    const stageHeight = stage.height();

    const worldX1 = (-camera.x) / camera.zoom;
    const worldY1 = (-camera.y) / camera.zoom;
    const worldX2 = (stageWidth - camera.x) / camera.zoom;
    const worldY2 = (stageHeight - camera.y) / camera.zoom;

    // Вычисляем какие тайлы нужны
    const minTileX = Math.floor(worldX1 / TILE_SIZE);
    const minTileY = Math.floor(worldY1 / TILE_SIZE);
    const maxTileX = Math.floor(worldX2 / TILE_SIZE);
    const maxTileY = Math.floor(worldY2 / TILE_SIZE);

    // Проверяем, какие тайлы уже загружены
    const tilesToLoad: string[] = [];
    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
      for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
        const key = `${tileX},${tileY}`;
        if (!tiles.has(key)) {
          tilesToLoad.push(key);
        }
      }
    }

    // Если все тайлы уже загружены, не делаем запрос
    if (tilesToLoad.length === 0) {
      return;
    }

    try {
      const response = await fetch(
        `${API_URL}/tiles?x1=${worldX1}&y1=${worldY1}&x2=${worldX2}&y2=${worldY2}`
      );
      const data = await response.json();

      const newTiles = new Map(tiles);
      const strokesMap = new Map<string, Stroke>();
      
      // Собираем все strokes из уже загруженных тайлов
      for (const [key, tile] of tiles.entries()) {
        for (const stroke of tile.strokes) {
          strokesMap.set(stroke.id, stroke);
        }
      }

      // Добавляем новые тайлы и их strokes
      for (const tile of data.tiles) {
        const key = `${tile.tileX},${tile.tileY}`;
        newTiles.set(key, tile);
        
        for (const stroke of tile.strokes) {
          strokesMap.set(stroke.id, stroke);
        }
      }
      
      setTiles(newTiles);
      setStrokes(Array.from(strokesMap.values()));
    } catch (error) {
      console.error('Error loading tiles:', error);
    }
  };

  useEffect(() => {
    // Debounce для загрузки тайлов - не загружаем при каждом движении камеры
    const timeoutId = setTimeout(() => {
      loadTiles();
    }, 200);

    // Подписываемся на видимые тайлы при изменении камеры
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      subscribeToVisibleTiles(wsRef.current);
    }

    return () => clearTimeout(timeoutId);
  }, [camera]);

  const handleMouseDown = (e: any) => {
    const stage = e.target.getStage();
    const point = stage.getPointerPosition();
    
    // Правая кнопка мыши - перетаскивание
    if (e.evt.button === 2 || e.evt.which === 3) {
      e.evt.preventDefault();
      setIsDragging(true);
      setDragStart({ x: point.x, y: point.y });
      return;
    }
    
    // Левая кнопка - рисование
    setIsDrawing(true);
    const worldX = (point.x - camera.x) / camera.zoom;
    const worldY = (point.y - camera.y) / camera.zoom;
    setCurrentStroke([worldX, worldY]);
  };

  const handleMouseMove = (e: any) => {
    const stage = e.target.getStage();
    const point = stage.getPointerPosition();
    
    // Перетаскивание камеры
    if (isDragging && dragStart) {
      const dx = point.x - dragStart.x;
      const dy = point.y - dragStart.y;
      setCamera({
        ...camera,
        x: camera.x + dx,
        y: camera.y + dy,
      });
      setDragStart({ x: point.x, y: point.y });
      return;
    }
    
    // Рисование
    if (!isDrawing) return;

    const worldX = (point.x - camera.x) / camera.zoom;
    const worldY = (point.y - camera.y) / camera.zoom;
    setCurrentStroke((prev) => [...prev, worldX, worldY]);
  };

  const handleMouseUp = async (e: any) => {
    // Остановка перетаскивания
    if (isDragging) {
      setIsDragging(false);
      setDragStart(null);
      return;
    }
    
    // Остановка рисования
    if (!isDrawing || currentStroke.length < 4) {
      setIsDrawing(false);
      setCurrentStroke([]);
      return;
    }

    const points: Array<[number, number]> = [];
    for (let i = 0; i < currentStroke.length; i += 2) {
      points.push([currentStroke[i], currentStroke[i + 1]]);
    }

    // Отправляем stroke без id - сервер сам его сгенерирует
    const strokeData = {
      tool: brush,
      color,
      width,
      points,
    };

    try {
      console.log(`[Frontend] Sending stroke to server: ${points.length} points`);
      const response = await fetch(`${API_URL}/strokes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(strokeData),
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`[Frontend] Stroke saved: ${data.strokeId}, received stroke:`, data.stroke);
        // Не добавляем stroke вручную - он придет через WebSocket от сервера
        // Это гарантирует, что все клиенты получат одинаковый stroke с правильным id
      } else {
        const errorText = await response.text();
        console.error(`[Frontend] Failed to save stroke: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      console.error('[Frontend] Error saving stroke:', error);
    }

    setIsDrawing(false);
    setCurrentStroke([]);
  };

  const handleWheel = (e: any) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    const pointer = stage.getPointerPosition();
    const mousePointTo = {
      x: (pointer.x - camera.x) / camera.zoom,
      y: (pointer.y - camera.y) / camera.zoom,
    };

    const newZoom = e.evt.deltaY > 0 ? camera.zoom * 0.9 : camera.zoom * 1.1;

    setCamera({
      x: pointer.x - mousePointTo.x * newZoom,
      y: pointer.y - mousePointTo.y * newZoom,
      zoom: newZoom,
    });
  };

  const currentLinePoints = currentStroke.length > 0 ? currentStroke : null;

  // Функция для получения стилей кисти
  const getBrushStyle = (brushType: BrushType) => {
    switch (brushType) {
      case 'pen':
        return { opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] };
      case 'brush':
        return { opacity: 0.8, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] };
      case 'marker':
        return { opacity: 0.7, lineCap: 'square' as const, lineJoin: 'miter' as const, dash: [] };
      case 'highlighter':
        return { opacity: 0.4, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] };
      case 'pencil':
        return { opacity: 0.9, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] };
      case 'chalk':
        return { opacity: 0.85, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [5, 5] };
      case 'eraser':
        return { opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] };
      default:
        return { opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] };
    }
  };

  const brushes: Array<{ type: BrushType; label: string; icon: string }> = [
    { type: 'pen', label: 'Ручка', icon: '✏️' },
    { type: 'brush', label: 'Кисть', icon: '🖌️' },
    { type: 'marker', label: 'Маркер', icon: '🖍️' },
    { type: 'highlighter', label: 'Хайлайтер', icon: '🖊️' },
    { type: 'pencil', label: 'Карандаш', icon: '✎' },
    { type: 'chalk', label: 'Мел', icon: '🖋️' },
    { type: 'eraser', label: 'Ластик', icon: '🧹' },
  ];

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          zIndex: 10,
          background: 'white',
          padding: '15px',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          minWidth: '200px',
        }}
      >
        <div style={{ marginBottom: '15px' }}>
          <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '8px', color: '#666' }}>
            Кисть:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {brushes.map((b) => (
              <button
                key={b.type}
                onClick={() => setBrush(b.type)}
                style={{
                  padding: '8px 12px',
                  border: brush === b.type ? '2px solid #007bff' : '1px solid #ddd',
                  borderRadius: '6px',
                  background: brush === b.type ? '#e7f3ff' : '#fff',
                  cursor: 'pointer',
                  fontSize: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  transition: 'all 0.2s',
                }}
                title={b.label}
              >
                <span>{b.icon}</span>
                <span style={{ fontSize: '11px' }}>{b.label}</span>
              </button>
            ))}
          </div>
        </div>
        {brush !== 'eraser' && (
          <div style={{ marginBottom: '10px' }}>
            <label style={{ fontSize: '12px', fontWeight: 'bold', color: '#666', display: 'block', marginBottom: '5px' }}>
              Цвет:
            </label>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{ width: '100%', height: '35px', cursor: 'pointer' }}
            />
          </div>
        )}
        <div style={{ marginBottom: '10px' }}>
          <label style={{ fontSize: '12px', fontWeight: 'bold', color: '#666', display: 'block', marginBottom: '5px' }}>
            Толщина: {width}px
          </label>
          <input
            type="range"
            min="1"
            max={brush === 'highlighter' ? '40' : brush === 'marker' ? '30' : brush === 'eraser' ? '50' : '20'}
            value={width}
            onChange={(e) => setWidth(parseInt(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ marginTop: '10px', fontSize: '11px', color: '#888' }}>
          Zoom: {camera.zoom.toFixed(2)}x
        </div>
        <button
          onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}
          style={{
            marginTop: '15px',
            padding: '8px 16px',
            border: '1px solid #ddd',
            borderRadius: '6px',
            background: '#fff',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 'bold',
            color: '#333',
            width: '100%',
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#f5f5f5';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#fff';
          }}
        >
          🏠 Вернуться в начало
        </button>
      </div>

      <Stage
        ref={stageRef}
        width={window.innerWidth}
        height={window.innerHeight}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.evt.preventDefault()}
      >
        <Layer
          x={camera.x}
          y={camera.y}
          scaleX={camera.zoom}
          scaleY={camera.zoom}
        >
          {strokes.map((stroke) => {
            const style = getBrushStyle(stroke.tool);
            const strokeColor = stroke.tool === 'eraser' ? '#ffffff' : stroke.color;
            return (
              <Line
                key={stroke.id}
                points={stroke.points.flat()}
                stroke={strokeColor}
                strokeWidth={stroke.width}
                tension={stroke.tool === 'chalk' ? 0.3 : 0.5}
                lineCap={style.lineCap}
                lineJoin={style.lineJoin}
                opacity={style.opacity}
                dash={style.dash}
                globalCompositeOperation={stroke.tool === 'eraser' ? 'destination-out' : 'source-over'}
              />
            );
          })}
          {currentLinePoints && (() => {
            const style = getBrushStyle(brush);
            const strokeColor = brush === 'eraser' ? '#ffffff' : color;
            return (
              <Line
                points={currentLinePoints}
                stroke={strokeColor}
                strokeWidth={width}
                tension={brush === 'chalk' ? 0.3 : 0.5}
                lineCap={style.lineCap}
                lineJoin={style.lineJoin}
                opacity={style.opacity}
                dash={style.dash}
                globalCompositeOperation={brush === 'eraser' ? 'destination-out' : 'source-over'}
              />
            );
          })()}
        </Layer>
      </Stage>
    </div>
  );
}

export default App;
