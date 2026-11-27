// XAIBO-PROD-620 (P7-T08; FR-20, FR-21): the interactive launch template for an agent, from the bundled catalog only (an
// imported entry can carry none: catalogIssues refuses it). A missing template is a disabled option with its reason, never a
// headless fallback. The launch layer validates the tokens again (P7-T02) and a launch grant gates execution (P7-T03).
import type { Catalog } from './validate.ts';

export type LaunchTemplate = { args: string[]; preallocatedId: boolean } | { disabled: string };
export const NOT_VERIFIED = 'Interactive launch not verified for this agent';

export function launchTemplate(catalog: Catalog, agent: string): LaunchTemplate {
  const a = catalog.agents.find((x) => x.id === agent);
  if (a?.launch) return { args: [...a.launch.args], preallocatedId: a.launch.preallocatedId === true };
  return { disabled: a?.launchDisabled ?? NOT_VERIFIED };
}
