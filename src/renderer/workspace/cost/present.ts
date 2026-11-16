// XAIBO-PROD-417 (P4-T07a; PRD FR-48, US-18, §5.12; design §6.3.2, §7.1 Estimated USD): the Cost section's words from
// the service's breakdown. Every amount carries ~ and accessible text starting "Estimated cost"; unavailable keeps its
// reason and is never 0; a reported zero stays ~$0.00; rates are the exact table rates per 1M tokens; revisions stay
// separate with their Prices as of; an owner fallback says so.
import type { CostComponent, CostDetail, CostGroup, PriceRevisionInfo } from '../../../shared/ipc.ts';
import { formatTime } from '../../model.ts';

// Review L5: half-up at the cent on the decimal text (10.005 -> 10.01), not on the binary product.
const round2 = (n: number) => { const r = Math.round(Number(`${n}e2`)) / 100; return Number.isFinite(r) ? r : Math.round(n * 100) / 100; };
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const exact = (n: number) => n.toLocaleString('en-US');

/** §7.1: ~$0.00 for a valid zero, ~$<0.01 below a cent, else two decimals half-up with comma grouping. */
export function usdText(n: number): string {
  return n > 0 && round2(n) < 0.01 ? '~$<0.01' : `~$${money(round2(n))}`;
}
export function usdWords(n: number): string {
  if (n === 0) return '0 US dollars';
  return n > 0 && round2(n) < 0.01 ? 'less than 0.01 US dollars' : `${money(round2(n))} US dollars`;
}

const REASONS: Record<string, string> = {
  'unpriced-model': 'model has no verified price', 'model-unavailable': 'model unavailable', 'tier-undetermined': 'pricing tier undetermined',
  'no-priced-component': 'no priced component', 'breakdown-unavailable': 'cost breakdown could not be read',
};
export function reasonText(code: string): string {
  const m = /^(unsupported|unknown)-(.+)$/.exec(code);
  return REASONS[code] ?? (m ? `${m[1]} ${m[2]!.replaceAll('_', ' ')}` : code.replaceAll(/[_-]/g, ' '));
}

export interface CostHeadline { value: string; label: string; basis: string; coverage: string; notes: string[] }
export function costHeadline(d: CostDetail): CostHeadline {
  const reported = d.basis === 'agent_reported';
  const coverage = `${d.priced} of ${d.requests} requests priced${d.gaps.length ? `; missing: ${d.gaps.map((g) => g.replaceAll('_', ' ')).join(', ')}` : ''}${
    d.reasons.length ? `; ${d.reasons.map(reasonText).join('; ')}` : ''}`;
  const notes: string[] = [];
  if (d.coverage === 'uncertain') notes.push('Aggregate coverage uncertain');
  if (reported) {
    notes.push('Agent-reported basis; local price revision not applied', 'Component cost unavailable — agent estimate has no split');
    if (d.groups.length) notes.push('Calculated components below are not added to the agent estimate');
  }
  if (d.more) notes.push('Showing the earliest model and price groups only');
  const basis = reported ? 'Agent-reported estimate' : 'Calculated from tokens';
  if (d.amountUsd === null || d.coverage === 'unavailable') {
    const why = d.requests === 0 ? 'no priced usage recorded' : d.reasons.length ? d.reasons.map(reasonText).join('; ') : 'no priced component';
    return { value: '~$ unavailable', label: `Estimated cost unavailable: ${why}`, basis, coverage, notes };
  }
  const partial = d.coverage === 'partial';
  const label = reported
    ? `Estimated cost: ${usdWords(d.amountUsd)}; agent-reported estimate${d.coverage === 'uncertain' ? '; aggregate coverage uncertain' : ''}`
    : `Estimated cost: ${usdWords(d.amountUsd)}${partial ? '; known subtotal' : ''}; ${coverage}`;
  return { value: `${usdText(d.amountUsd)}${partial ? ' known subtotal' : ''}`, label, basis, coverage, notes };
}

const NAMES: Record<CostComponent['name'], string> = {
  uncached_input: 'Input (uncached)', cache_read: 'Cache read', cache_write: 'Cache write', cache_write_5m: 'Cache write (5 min)',
  cache_write_1h: 'Cache write (1 h)', output: 'Output',
};
export interface ComponentRow { name: string; tokens: string; rate: string; usd: string; label: string }
export function componentRows(g: CostGroup): ComponentRow[] {
  return g.components.map((c) => {
    const name = NAMES[c.name];
    const plural = (n: number) => `${n} request${n === 1 ? '' : 's'}`;
    const without = `${c.missing ? ` · ${plural(c.missing)} without this component` : ''}${c.unpriced ? ` · ${plural(c.unpriced)} not priced for this component` : ''}`;
    const subtotal = c.unpriced > 0 || c.missing > 0; // review M1: a request priced without this component leaves a subtotal
    // review L6: the exact table decimal, never exponent notation
    const rate = c.rate !== null ? `$${c.rate.toLocaleString('en-US', { maximumFractionDigits: 20 })} per 1M tokens` : c.rateVaries ? 'Rate varies by tier' : 'Rate unavailable';
    if (c.usd === null) {
      const why = c.rate === null && !c.rateVaries ? 'no applied rate' : c.tokens === null ? 'tokens unavailable' : 'not priced';
      return { name, tokens: `${c.tokens === null ? 'Unavailable' : exact(c.tokens)}${without}`, rate, usd: '~$ unavailable', label: `Estimated cost unavailable: ${name}, ${why}` };
    }
    return { name, tokens: `${c.tokens === null ? 'Unavailable' : exact(c.tokens)}${without}`, rate, usd: `${usdText(c.usd)}${subtotal ? ' known subtotal' : ''}`,
      label: `Estimated cost: ${usdWords(c.usd)} for ${name}${subtotal ? '; known subtotal' : ''}` };
  });
}

/** Review M1 (P4-T07b): revisions are unique by content, not label; a shared label names its revision id. */
function revisionLabel(revisions: PriceRevisionInfo[], id: number): string | null {
  const r = revisions.find((x) => x.id === id);
  if (!r) return null;
  return revisions.some((x) => x.id !== id && x.label === r.label) ? `${r.label} (revision ${id})` : r.label;
}

export function groupTitle(g: CostGroup, revisions: PriceRevisionInfo[]): string {
  const rev = (g.revision === null ? null : revisionLabel(revisions, g.revision)) ?? (g.revision === null ? 'unavailable' : `revision ${g.revision}`);
  return `${g.model} · ${g.basis === 'owner_fallback' ? 'Owner-set fallback' : `Price table ${rev}`} · ${g.priced} of ${g.requests} requests priced`;
}

export interface RevisionRow { id: number; label: string; asOf: string; source: string; references: string[]; fallback: boolean; models: string; period: string }
/** One row per applied immutable revision; multiple revisions stay separate (editing today's table never reprices). */
export function revisionRows(d: CostDetail): RevisionRow[] {
  return d.revisions.map((r) => {
    const gs = d.groups.filter((g) => g.revision === r.id);
    const from = gs.map((g) => g.from).filter((x): x is number => x !== null), to = gs.map((g) => g.to).filter((x): x is number => x !== null);
    return {
      id: r.id, label: revisionLabel(d.revisions, r.id) ?? r.label, asOf: `Prices as of ${r.pricesAsOf ?? 'unavailable'}`, source: r.source === 'bundled' ? 'Bundled price table' : 'Owner override',
      references: r.references, fallback: r.references.includes('Owner-set fallback') || gs.some((g) => g.basis === 'owner_fallback'),
      models: [...new Set(gs.map((g) => g.model))].join(', '),
      period: from.length && to.length ? `${formatTime(Math.min(...from))} – ${formatTime(Math.max(...to))}` : 'Period unavailable',
    };
  });
}
