// XAIBO-PROD-568 (P6-T11; design §6.6 Local prices / Owner-set fallback, C30, §6.11 price rates): the texts of Settings >
// Local prices. Rates are the exact source decimals in USD per 1,000,000 tokens (never rounded or abbreviated); a result never
// claims a switch the service did not make, and never carries a path.
import type { PriceCheck, PriceError, PriceView, RevealResult } from '../../shared/ipc.ts';

export const asOfText = (v: PriceView) => `Prices as of ${v.pricesAsOf}, revision ${v.revision}`;
export const sourceText = (v: PriceView) => (v.source === 'override' ? 'Override file' : 'Bundled table');

const ERROR_TEXT: Record<PriceError, string> = {
  override_unreadable: 'the file could not be read',
  override_not_regular: 'it is not a regular file',
  override_too_large: 'it is larger than 1 MiB',
  override_json: 'it is not valid JSON',
  override_schema: 'it does not match the price schema',
};
export const errorText = (e: PriceError) => ERROR_TEXT[e];

export function checkText(c: PriceCheck): string {
  if (c === 'valid') return 'The override file is valid. Reload to use it.';
  if (c === 'absent') return 'No override file found. Reload would use the bundled prices.'; // in use until Reload (code review 1)
  return `Not valid: ${errorText(c)}. Prices are unchanged.`;
}

/** After a Reload, and on load while the last load refused the override. */
export function reloadText(v: PriceView): string {
  if (v.error) return `Override not used: ${errorText(v.error)}. The last valid prices stay in use.`;
  return v.source === 'override' ? 'Override prices loaded.' : 'No override file: bundled prices are in use.';
}

const REVEAL_TEXT: Record<RevealResult, string> = {
  file: 'Shown in Finder.',
  missing: 'No override file yet. Its folder is shown in Finder.',
  folder: 'The override path is not a regular file. Its folder is shown in Finder.',
  failed: 'Finder could not show the file.',
};
export const revealText = (r: RevealResult) => REVEAL_TEXT[r];
/** main's answer is untrusted at this boundary too: anything else is a failure. */
export const parseReveal = (x: unknown): RevealResult => (typeof x === 'string' && Object.hasOwn(REVEAL_TEXT, x) ? x as RevealResult : 'failed');

/** The exact decimal (1e-7 -> 0.0000001); the schema caps rates at 100000, so no large-number exponent occurs.
 *  ponytail (code review 2): a non-zero rate below 1e-20 prints as 0; widen the toFixed digits if such a rate ever appears. */
export function rateText(n: number): string {
  const s = String(n);
  return s.includes('e') ? n.toFixed(20).replace(/\.?0+$/, '') : s;
}
const rate = (n: number) => `USD ${rateText(n)} per 1,000,000 tokens`;

export interface FallbackRow { key: string; models: string; scope: string; rates: { label: string; text: string }[] }
export const fallbackRows = (v: PriceView): FallbackRow[] => v.fallbacks.map((f, i) => ({
  key: String(i),
  models: f.models.join(', '),
  scope: f.agent ? `Agent ${f.agent}` : 'All agents',
  rates: [
    { label: 'Input', text: rate(f.rates.input) },
    { label: 'Output', text: rate(f.rates.output) },
    ...(f.rates.cache_read !== undefined ? [{ label: 'Cache read', text: rate(f.rates.cache_read) }] : []),
    ...Object.entries(f.rates.cache_write ?? {}).map(([k, n]) => ({ label: `Cache write (${k})`, text: rate(n) })),
  ],
}));
