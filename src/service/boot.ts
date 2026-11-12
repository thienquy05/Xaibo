// Service boot (P1-T06; T08 rescan on start, D-P1-09): opens the store in the data dir, then in the background reads
// the login-shell env, detects agents, syncs profiles and starts one adapter per Claude or Codex profile (P2-T03).
// A read-only store (EC-45) is reported and skips ingest. P1-T12: commit and agent-status hooks for the renderer, and
// a manual executable path ("Set path…") that re-detects that agent.
import path from 'node:path';
import type { AgentStatus } from '../shared/ipc.ts';
import type { Logger } from '../shared/log.ts';
import { ClaudeAdapter } from './adapters/claude/index.ts';
import { CodexAdapter } from './adapters/codex/index.ts';
import type { Ingester } from './adapters/tail-adapter.ts';
import { detectAgent, manualPath, manualRoots, profileRoots, setManualPath, syncProfiles, type Detection } from './catalog/detect.ts';
import { readLoginEnv, type LoginEnv } from './catalog/env.ts';
import { loadCatalog, type Catalog, type SessionKind } from './catalog/validate.ts';
import { loadModels, type ModelEntry } from './usage/models.ts';
import { openStore, type Store } from './store/db.ts';
import { Writer, type Batch } from './store/writer.ts';

export interface BootOptions {
  dataDir: string; home: string; shell?: string | undefined; catalog?: Catalog; intervalMs?: number; log?: Logger;
  onCommit?: (batch: Batch) => void;
  onAgents?: (agents: AgentStatus[]) => void;
}
export interface Service {
  store: Store;
  detections: Detection[];
  adapters: Ingester[];
  /** Settles when detection, profile sync and the initial backfill are done. */
  done: Promise<void>;
  /** Agent status for the renderer; null until detection has run. */
  agents(): AgentStatus[] | null;
  /** Catalog session kinds for list badges (P2-T04); empty if the catalog failed to load. */
  kinds(): SessionKind[];
  /** Bundled model list for display names (P2-T08); empty if it failed to load (names fall back to raw ids). */
  models(): ModelEntry[];
  /** Validates and stores a manual executable path, then re-detects that agent; false if refused. */
  setPath(agent: string, file: string): Promise<boolean>;
  wake(): Promise<void>;
  stop(): void;
}

export async function boot(o: BootOptions): Promise<Service> {
  const store = await openStore({ file: path.join(o.dataDir, 'xaibo.db'), backupDir: path.join(o.dataDir, 'backups') });
  const { db, readOnly } = store;
  const writer = new Writer(db, o.onCommit ? { onCommit: o.onCommit } : {});
  const detections: Detection[] = [];
  let models: ModelEntry[] = [];
  try { models = loadModels().models; } catch { o.log?.log('models_invalid', {}); } // ponytail: override + revisions in P2-T09
  const adapters: Ingester[] = [];
  let stopped = false;
  let catalog: Catalog | undefined;
  let env: LoginEnv = {};
  let detected = false;
  let markDetected = () => {};
  const detection = new Promise<void>((resolve) => { markDetected = resolve; });

  const agents = (): AgentStatus[] | null => (!detected ? null : detections.map((d) => ({
    agent: d.agent, name: catalog?.agents.find((a) => a.id === d.agent)?.displayName ?? d.agent, state: d.state,
    version: d.state === 'detected' ? d.version : null,
  })));
  const announce = () => { const a = agents(); if (a) o.onAgents?.(a); };

  const start = async () => {
    try {
      catalog = o.catalog ?? loadCatalog();
      env = await readLoginEnv({ shell: o.shell, ...(o.log ? { log: o.log } : {}) });
      // A read-only store may lack kv (failed first migration): detect without manual paths then.
      detections.push(...await Promise.all(catalog.agents.map((a) =>
        detectAgent(a, { env, home: o.home, manualPath: readOnly ? undefined : manualPath(db, a.id), ...(o.log ? { log: o.log } : {}) }))));
      o.log?.log('detect', Object.fromEntries(detections.map((d) => [d.agent, d.state === 'detected'])));
    } finally { // a failed detection (e.g. a bad catalog) announces an empty list, never "detecting" forever
      detected = true;
      markDetected();
      announce();
    }
    if (stopped || readOnly) return;
    const manual = Object.fromEntries(catalog.agents.map((a) => [a.id, manualRoots(db, a.id)]));
    const profiles = syncProfiles(db, profileRoots(catalog, env, o.home, manual));
    const Adapters: Record<string, typeof ClaudeAdapter | typeof CodexAdapter> = { claude: ClaudeAdapter, codex: CodexAdapter };
    for (const p of profiles.filter((x) => Adapters[x.agent])) {
      if (stopped) return;
      const a = new Adapters[p.agent]!({ db, writer, profileId: p.id, root: p.root, ...(o.intervalMs ? { intervalMs: o.intervalMs } : {}) });
      adapters.push(a);
      await a.start();
    }
    o.log?.log('backfill_done', { profiles: profiles.length });
  };

  const done = start();
  done.catch(() => undefined); // callers observe it; this only keeps an early failure from being unhandled meanwhile
  return {
    store, detections, adapters, done, agents,
    kinds: () => catalog?.sessionKinds ?? [],
    models: () => models,
    async setPath(agent, file) {
      await Promise.race([detection, done.catch(() => undefined)]); // detection, not the whole backfill
      const entry = catalog?.agents.find((a) => a.id === agent);
      const i = detections.findIndex((d) => d.agent === agent);
      if (stopped || readOnly || !entry || i < 0 || !(await setManualPath(db, agent, file))) return false;
      detections[i] = await detectAgent(entry, { env, home: o.home, manualPath: manualPath(db, agent), ...(o.log ? { log: o.log } : {}) });
      announce();
      return true;
    },
    wake: async () => { await Promise.all(adapters.map((a) => a.wake())); },
    stop: () => {
      stopped = true;
      for (const a of adapters) a.stop();
      writer.flush();
      db.close();
    },
  };
}
