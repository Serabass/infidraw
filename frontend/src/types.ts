export type BrushType = 'pen' | 'brush' | 'marker' | 'highlighter' | 'eraser' | 'pencil' | 'chalk';

export interface Stroke {
  id: string;
  ts: number;
  tool: BrushType;
  color: string;
  width: number;
  points: Array<[number, number]>;
  authorId?: string;
  hidden?: boolean;
}

export interface TileResponse {
  tileX: number;
  tileY: number;
  version: number;
  snapshotUrl?: string;
  strokes: Stroke[];
}
