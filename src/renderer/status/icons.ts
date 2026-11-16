// Design §4 icon geometry as data (24×24 grid, 1.75 stroke, round caps; drawn by StatusBadge.tsx). Only the icons in
// use are listed; add the rest from §4 verbatim when a surface needs them, never new shapes.
export type Shape =
  | { kind: 'path'; d: string; dash?: true }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill?: true; dash?: true };

const line = (...pts: [number, number][]): Shape => ({ kind: 'path', d: `M${pts.map(([x, y]) => `${x} ${y}`).join(' L')}` });

const GEOMETRY = {
  dashboard: [{ kind: 'path', d: 'M4.5 3h4A1.5 1.5 0 0 1 10 4.5v4A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5v-4A1.5 1.5 0 0 1 4.5 3z M15.5 3h4A1.5 1.5 0 0 1 21 4.5v4A1.5 1.5 0 0 1 19.5 10h-4A1.5 1.5 0 0 1 14 8.5v-4A1.5 1.5 0 0 1 15.5 3z M4.5 14h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 8.5 21h-4A1.5 1.5 0 0 1 3 19.5v-4A1.5 1.5 0 0 1 4.5 14z M15.5 14h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5z' }],
  session: [{ kind: 'path', d: 'M7 3h8l4 4v14H5V3h2m8 0v5h4M8 12h8M8 16h6' }],
  link: [line([3, 8], [9, 8], [9, 16], [3, 16]), line([21, 8], [15, 8], [15, 16], [21, 16]), line([9, 12], [15, 12])],
  hourglass: [line([5, 3], [19, 3], [19, 6], [8, 18], [8, 21]), line([5, 21], [19, 21]), line([5, 6], [16, 18], [16, 21])],
  restore: [line([5, 11], [5, 5], [11, 5]), line([5, 5], [17, 5], [20, 9], [20, 17], [16, 20], [7, 20])],
  finding: [line([12, 3], [22, 21], [2, 21], [12, 3]), line([12, 9], [12, 14]), { kind: 'circle', cx: 12, cy: 18, r: 0.5 }],
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
  // P4-T05d (Session workspace): from §4 verbatim
  chevron: [line([9, 5], [16, 12], [9, 19])],
  back: [line([13, 5], [6, 12], [13, 19]), line([6, 12], [21, 12])],
  close: [line([6, 6], [18, 18]), line([18, 6], [6, 18])],
  check: [line([4, 12], [9, 17], [20, 6])],
  information: [{ kind: 'circle', cx: 12, cy: 12, r: 9 }, line([12, 11], [12, 17]), { kind: 'circle', cx: 12, cy: 7, r: 0.5 }],
  file: [line([6, 3], [14, 3], [19, 8], [19, 21], [6, 21], [6, 3]), line([14, 3], [14, 8], [19, 8])],
  external: [{ kind: 'rect', x: 4, y: 9, w: 11, h: 11 }, line([10, 14], [20, 4]), line([13, 4], [20, 4], [20, 11])],
  // P4-T06b: Stale (design §4)
  'clock-gap': [line([12, 3], [5, 3], [3, 10], [5, 18], [12, 21], [20, 17], [21, 10]), line([12, 7], [12, 12], [16, 12])],
} satisfies Record<string, Shape[]>;

export type IconId = keyof typeof GEOMETRY;
export const ICONS: Record<IconId, Shape[]> = GEOMETRY;
export const ICON_IDS = Object.keys(ICONS) as IconId[];
