// XAIBO-PROD-438 (D-P4-10; design §6.13 B3): the state behind every Retry. A Retry is disabled while it runs; a
// failure counts and stamps its time, so a failed retry reads "Still couldn't …" with the clock; success resets.
import { clock } from './workspace/view.ts';

export interface Retry { failures: number; at: number | null; busy: boolean }
export const retryIdle: Retry = { failures: 0, at: null, busy: false };
export type RetryEvent = { type: 'start' } | { type: 'fail'; at: number } | { type: 'ok' };

export function retryStep(s: Retry, e: RetryEvent): Retry {
  switch (e.type) {
    case 'start': return s.busy ? s : { ...s, busy: true };
    // review HIGH: only the first failure and a failed user retry count; a background reload failing again changes nothing
    case 'fail': return s.busy || s.failures === 0 ? { failures: s.failures + 1, at: e.at, busy: false } : s;
    case 'ok': return retryIdle;
  }
}

/** Short notice, as modern apps word it: "Couldn't load transcript"; after a failed retry "Still couldn't load
 *  transcript · 14:32". `refresh` when earlier data stays shown. */
export function failText(thing: string, failures: number, at: number | null, verb: 'load' | 'refresh' = 'load'): string {
  return failures > 1 ? `Still couldn't ${verb} ${thing} · ${clock(at)}` : `Couldn't ${verb} ${thing}`;
}

export const retryLabel = (busy: boolean): string => (busy ? 'Retrying…' : 'Retry');
