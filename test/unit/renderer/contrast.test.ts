// P4-T01 (design §2.1, §8.2, F7, OQ-X15): parse the literal token values in tokens.css and test every inventoried
// foreground/background pair in both themes against its threshold and the design's reported ratio (to 0.01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dirname, '..', '..', '..', 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');

/** Custom properties declared directly in a `:root { … }` block. */
function declarations(block: string): Map<string, string> {
  return new Map([...block.matchAll(/(--x-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const light = declarations(CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('}', CSS.indexOf(':root {')))); // the first :root block only
const darkBlock = CSS.slice(CSS.indexOf('@media (prefers-color-scheme: dark)'));
const dark = new Map([...light, ...declarations(darkBlock)]);

function color(theme: Map<string, string>, name: string): string {
  let v = theme.get(name);
  for (let i = 0; v?.startsWith('var(') && i < 4; i++) v = theme.get(v.slice(4, -1).trim());
  assert.ok(v && /^#[0-9A-Fa-f]{6}$/.test(v), `${name} resolves to a hex color (got ${v})`);
  return v!;
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

// design §8.2: [foreground, background, threshold, light ratio, dark ratio]
const PAIRS: [string, string, number, number, number][] = [
  ['ink', 'canvas', 4.5, 14.13, 14.03], ['ink', 'surface', 4.5, 15.28, 12.80], ['ink', 'tint', 4.5, 12.10, 10.63],
  ['muted', 'canvas', 4.5, 6.23, 8.65], ['muted', 'surface', 4.5, 6.74, 7.89], ['muted', 'tint', 4.5, 5.34, 6.55],
  ['accent', 'canvas', 4.5, 7.75, 9.29], ['accent', 'surface', 4.5, 8.38, 8.48], ['accent', 'tint', 4.5, 6.64, 7.04],
  ['success', 'canvas', 4.5, 6.51, 9.86], ['success', 'surface', 4.5, 7.04, 9.00], ['success', 'tint', 4.5, 5.57, 7.47],
  ['warning', 'canvas', 4.5, 6.42, 9.55], ['warning', 'surface', 4.5, 6.95, 8.71], ['warning', 'tint', 4.5, 5.50, 7.23],
  ['danger', 'canvas', 4.5, 6.46, 8.55], ['danger', 'surface', 4.5, 6.99, 7.80], ['danger', 'tint', 4.5, 5.53, 6.48],
  ['line', 'canvas', 3, 3.78, 5.40], ['line', 'surface', 3, 4.08, 4.93], ['line', 'tint', 3, 3.23, 4.09],
  ['focus', 'canvas', 3, 7.75, 9.29], ['focus', 'surface', 3, 8.38, 8.48], ['focus', 'selected', 3, 6.64, 7.04],
  ['chart', 'inset', 3, 7.75, 9.29], ['chart', 'surface', 3, 8.38, 8.48], ['chart', 'tint', 3, 6.64, 7.04],
];

test('every §8.2 pair meets its threshold in both themes and matches the design ratio to 0.01 (27 × 2)', () => {
  assert.equal(PAIRS.length, 27);
  for (const [fg, bg, min, wantLight, wantDark] of PAIRS) {
    for (const [theme, want, name] of [[light, wantLight, 'light'], [dark, wantDark, 'dark']] as const) {
      const r = ratio(color(theme, `--x-${fg}`), color(theme, `--x-${bg}`));
      assert.ok(r >= min, `${fg}/${bg} ${name}: ${r.toFixed(2)} < ${min}`);
      assert.ok(Math.abs(r - want) < 0.005 + 1e-9, `${fg}/${bg} ${name}: ${r.toFixed(2)} vs design ${want}`);
    }
  }
});

test('the dark block redefines exactly the ten base colors; aliases stay aliases', () => {
  const base = ['canvas', 'surface', 'tint', 'ink', 'muted', 'accent', 'success', 'warning', 'danger', 'line'].map((n) => `--x-${n}`);
  assert.deepEqual([...declarations(darkBlock).keys()].sort(), [...base].sort());
  for (const [alias, to] of [['focus', 'accent'], ['chart', 'accent'], ['selected', 'tint'], ['inset', 'canvas']]) {
    assert.equal(light.get(`--x-${alias}`), `var(--x-${to})`, alias);
  }
});

test('design §2.2–§2.3 literal values (type, space, geometry, motion, stacking, breakpoints, window sizes)', () => {
  const want: Record<string, string> = {
    'font-ui': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', 'font-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    'text-small': '0.8125rem', 'leading-small': '1.25rem', 'text-body': '0.875rem', 'leading-body': '1.375rem',
    'text-section': '1rem', 'leading-section': '1.5rem', 'text-title': '1.5rem', 'leading-title': '1.875rem',
    'text-value': '1.25rem', 'leading-value': '1.75rem', 'weight-normal': '400', 'weight-strong': '600', tracking: '0',
    'space-1': '4px', 'space-2': '8px', 'space-3': '12px', 'space-4': '16px', 'space-5': '20px', 'space-6': '24px', 'space-8': '32px', 'space-10': '40px',
    'radius-control': '4px', 'radius-panel': '8px', 'radius-badge': '2px', border: '1px solid var(--x-line)', 'selected-border': '3px solid var(--x-accent)',
    'focus-width': '2px', 'focus-offset': '2px', 'shadow-flat': 'none', 'shadow-raised': '0 8px 24px rgb(0 0 0 / 0.16)',
    'control-height': '36px', 'target-min': '32px', 'row-min': '104px', 'chrome-height': '56px', 'health-height': '36px',
    'content-max': '1440px', 'panel-gap': '24px', 'evidence-margin': '28px', 'duration-state': '80ms', 'duration-disclosure': '120ms', ease: 'ease-out',
    'z-base': '0', 'z-sticky': '10', 'z-menu': '20', 'z-toast': '30', 'z-dialog': '40', 'z-tooltip': '50', 'break-narrow': '800px', 'break-wide': '1200px',
    'window-min-width': '640px', 'window-min-height': '560px', 'window-default-width': '960px', 'window-default-height': '640px',
  };
  for (const [k, v] of Object.entries(want)) assert.equal(light.get(`--x-${k}`), v, k);
});
