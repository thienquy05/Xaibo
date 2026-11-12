// Model list and display names (P2-T08, FR-51, EC-101). integrations/models.json is validated strictly (ajv, as the
// agent catalog). Name precedence: an agent-provided name only for its own model id -> the list's display_name -> the
// raw id; no model evidence -> "Model unavailable". Exact ids only: never a family or prefix guess.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';

export interface Rates { input: number; output: number; cache_read?: number; cache_write?: Record<string, number> }
export interface ModelEntry {
  id: string; display_name: string; family?: string; context_window?: number; source: string; prices_verified: boolean;
  rates?: Rates; tiers?: { above_prompt_tokens: number; rates: Rates }[];
}
export interface ModelList {
  schemaVersion: 1; revision: string; currency: 'USD'; prices_as_of: string;
  sources: { id: string; url: string; retrieved: string }[]; models: ModelEntry[];
}

const DIR = new URL('../../../integrations/', import.meta.url); // same depth under src/ and out/
const check = new Ajv2020({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(new URL('models.schema.json', DIR), 'utf8')) as object);

/** Schema errors plus cross-field rules (known source ids, unique model ids), as short text; empty = valid. */
export function validateModels(value: unknown): string[] {
  if (!check(value)) return (check.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
  const list = value as ModelList;
  const sources = new Set(list.sources.map((s) => s.id));
  const errors = list.models.filter((m) => !sources.has(m.source)).map((m) => `/models ${m.id}: unknown source ${m.source}`);
  if (new Set(list.models.map((m) => m.id)).size !== list.models.length) errors.push('/models duplicate id');
  return errors;
}

export function loadModels(url: URL = new URL('models.json', DIR)): ModelList {
  const value: unknown = JSON.parse(readFileSync(url, 'utf8'));
  const errors = validateModels(value);
  if (errors.length) throw new Error(`invalid model list: ${errors.join('; ')}`);
  return value as ModelList;
}

export const MODEL_UNAVAILABLE = 'Model unavailable';

export function displayName(models: ModelEntry[], modelId: string | null, agent?: { modelId: string; name: string }): string {
  if (!modelId) return MODEL_UNAVAILABLE;
  if (agent && agent.modelId === modelId) return agent.name;
  return models.find((m) => m.id === modelId)?.display_name ?? modelId;
}

/** "<name> · <effort>"; effort omitted when the agent does not expose it. */
export const modelLabel = (name: string, effort: string | null): string => (effort ? `${name} · ${effort}` : name);
