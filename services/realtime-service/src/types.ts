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

export interface StrokeEvent {
  type: 'stroke_created' | 'stroke_erased' | 'stroke_hidden';
  strokeId: string;
  stroke?: Stroke;
  timestamp: number;
}
