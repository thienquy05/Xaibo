// Design §4 icon geometry as data (24×24 grid, 1.75 stroke, round caps; drawn by StatusBadge.tsx). Only the icons in
// use are listed; add the rest from §4 verbatim when a surface needs them, never new shapes.
export type Shape =
  | { kind: 'path'; d: string; dash?: true }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill?: true; dash?: true };

const line = (...pts: [number, number][]): Shape => ({ kind: 'path', d: `M${pts.map(([x, y]) => `${x} ${y}`).join(' L')}` });

const GEOMETRY = {
  idle: [{ kind: 'circle', cx: 12, cy: 12, r: 7 }],
  busy: [line([3, 15], [7, 9], [12, 15], [17, 9], [21, 15])],
  permission: [line([6, 20], [6, 10], [9, 10], [9, 5], [12, 5], [12, 11], [15, 8], [18, 11], [18, 17], [15, 20], [6, 20])],
  input: [{ kind: 'rect', x: 4, y: 5, w: 16, h: 11 }, line([8, 16], [8, 20], [12, 16]), line([8, 10], [16, 10])],
  error: [line([6, 6], [18, 18]), line([18, 6], [6, 18]), { kind: 'circle', cx: 12, cy: 12, r: 10 }],
  ended: [{ kind: 'rect', x: 5, y: 5, w: 14, h: 14 }, line([9, 12], [15, 12])],
  unknown: [line([9, 4], [4, 4], [4, 20], [9, 20]), line([15, 4], [20, 4], [20, 20], [15, 20]), { kind: 'circle', cx: 12, cy: 12, r: 1 }],
  'evidence-solid': [{ kind: 'rect', x: 7, y: 7, w: 10, h: 10, fill: true }],
  'evidence-open': [{ kind: 'rect', x: 7, y: 7, w: 10, h: 10 }],
  'evidence-dashed': [{ kind: 'rect', x: 7, y: 7, w: 10, h: 10, dash: true }],
  settle: [line([5, 6], [19, 6]), line([5, 12], [15, 12]), line([5, 18], [11, 18])],
  branch: [line([7, 3], [7, 17], [11, 21]), line([7, 11], [17, 11], [17, 5])],
} satisfies Record<string, Shape[]>;

export type IconId = keyof typeof GEOMETRY;
export const ICONS: Record<IconId, Shape[]> = GEOMETRY;
export const ICON_IDS = Object.keys(ICONS) as IconId[];
