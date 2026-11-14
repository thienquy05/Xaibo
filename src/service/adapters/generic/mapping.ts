// Catalog hook mappings (P3-T13a; PRD §6.8): a hook envelope becomes normalized status evidence when its exact event name
// and every exact field predicate (null = absent or null) match a catalog rule; the first match wins. Paths walk own
// properties only and values are compared, never evaluated. No matching rule, or a tool rule without its id, is null:
// reduced coverage for the engine, never an invented state. Ids and names are kept only up to 256 characters.
import type { Envelope } from '../../../shared/hook-protocol.ts';
import type { HookMappings } from '../../catalog/validate.ts';
import type { Ev } from '../../status/engine.ts';
import { sigField } from '../../status/rules.ts';

function at(o: unknown, path: string): unknown {
  let v = o;
  for (const k of path.split('.')) {
    if (typeof v !== 'object' || v === null || Array.isArray(v) || !Object.hasOwn(v, k)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}
const name = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null);

export function hookMapper(m: HookMappings): (e: Envelope) => Ev[] | null {
  return (e) => {
    const p = e.payload ?? {};
    const r = m.rules.find((x) => x.event === e.event
      && Object.entries(x.where ?? {}).every(([path, want]) => { const got = at(p, path); return want === null ? got === undefined || got === null : got === want; }));
    if (!r) return null;
    const model = m.model ? name(at(p, m.model)) : null;
    const tail: Ev[] = model ? [{ k: 'model', id: model }] : [];
    if (r.map === 'tool.start' || r.map === 'tool.end') {
      const id = r.id ? name(at(p, r.id)) : null;
      if (!id) return null;
      if (r.map === 'tool.end') return [{ k: 'tool.end', id, ...(r.result ? sigField(at(p, r.result)) : {}) }, ...tail];
      const tool = r.tool ? name(at(p, r.tool)) : null;
      return [{ k: 'tool.start', id, ...(tool ? { tool } : {}), ...(r.args ? sigField(at(p, r.args), tool) : {}) }, ...tail];
    }
    const ev: Ev = r.map === 'busy' ? { k: 'activity', reopen: true } : r.map === 'turn.start' ? { k: 'turn.start', typed: true } : { k: r.map };
    return [ev, ...tail];
  };
}
