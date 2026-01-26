export interface Stroke {
  id: string;
  ts: number;
  tool: 'pen' | 'eraser';
  color: string;
  width: number;
  points: Array<[number, number]>;
  authorId?: string;
  hidden?: boolean;
}

export interface StrokeEvent {
  type: 'stroke_created' | 'stroke_erased' | 'stroke_hidden';
  strokeId: string;
  stroke?: Stroke;
  timestamp: number;
}

export interface TileRequest {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  sinceVersion?: number;
}

export interface TileResponse {
  tileX: number;
  tileY: number;
  version: number;
  snapshotUrl?: string;
  strokes: Stroke[];
}
