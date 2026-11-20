// XAIBO-PROD-510 (P5-T01c; FR-53, design §6.5.1): the Agent Map projection over the persisted grouping (migration 015) and
// manual project overlays. Roots: Project overrides (by id), repositories (by common-directory key), cwd folders (by cwd),
// then Cwd unavailable. A repository's children are its worktrees; a project's are repository-qualified worktrees, cwd
// folders and Cwd unavailable. A moved session belongs only to its project. Counts, live count and agent inventory are
// aggregates over the group's whole scope (the same WHERE the history leaf filter uses), never sums of loaded rows.
import type { DatabaseSync } from 'node:sqlite';
import { REPO_REASONS, type MapGroup, type MapNode } from '../../shared/ipc.ts';
import type { LiveOf } from '../api.ts';
import { LIVE_WINDOW_MS } from '../status/feed.ts';
import { notPurging } from './suppression.ts';

/** Design §6.5.1 page caps: 10 root groups, 20 children per branch page (leaves page through listHistory, cap 100). */
export const MAP_ROOTS = 10, MAP_CHILDREN = 20;
const OVERLAY = 'LEFT JOIN overlays o ON o.agent = s.agent AND o.profile_id = s.profile_id AND o.native_session_id = s.native_session_id';
// Review M1: a cwd is a folder key only when it is 1..32768 characters (SQLite counts code points, so at most 65536 UTF-16
// units, the IPC key bound); an empty or longer stored cwd joins Cwd unavailable, so every group passes the reply parser.
const CWD_KNOWN = 'length(s.cwd) BETWEEN 1 AND 32768';
const CWD_UNKNOWN = `NOT coalesce(${CWD_KNOWN}, 0)`;

/** The WHERE terms selecting a group's sessions (overlays joined as `o`, sessions as `s`); trashed sessions excluded. */
export function groupWhere(g: MapGroup): { where: string[]; args: (string | number)[] } {
  const where = ['o.trashed_at IS NULL', g.project === null ? 'o.project_id IS NULL' : 'o.project_id = ?'];
  const args: (string | number)[] = g.project === null ? [] : [g.project];
  const at = g.at;
  if (at && 'repo' in at) {
    where.push('s.repo_key = ?'); args.push(at.repo);
    if (at.worktree !== null) { where.push('s.worktree = ?'); args.push(at.worktree); }
  } else if (at) {
    where.push('s.repo_key IS NULL', at.cwd === null ? CWD_UNKNOWN : 's.cwd = ?');
    if (at.cwd !== null) args.push(at.cwd);
  }
  return { where, args };
}

const isRepo = (g: MapGroup, worktree: boolean) => g.at !== null && 'repo' in g.at && (g.at.worktree !== null) === worktree;
const isCwd = (g: MapGroup, known: boolean) => g.at !== null && 'cwd' in g.at && (g.at.cwd !== null) === known;
/** One ordered run of groups; `has` tells whether a cursor group belongs to it, `page` continues after that cursor. */
interface Seg { has: (g: MapGroup) => boolean; page: (after: MapGroup | null, n: number) => MapGroup[] }

function segments(db: DatabaseSync, parent: MapGroup | null): Seg[] {
  const keys = (sql: string, args: (string | number)[], n: number) => db.prepare(sql).all(...args, n) as Record<string, string | number>[];
  // the sessions of one project, or of automatic grouping, as the FROM + WHERE prefix of a keyset query
  const from = (project: number | null, op = '=') => project === null
    ? { sql: `FROM sessions s ${OVERLAY} WHERE o.trashed_at IS NULL AND o.project_id IS NULL AND ${notPurging(db)}`, args: [] as (string | number)[] }
    : { sql: `FROM overlays o JOIN sessions s ON s.agent = o.agent AND s.profile_id = o.profile_id AND s.native_session_id = o.native_session_id
        WHERE o.trashed_at IS NULL AND o.project_id ${op} ? AND ${notPurging(db)}`, args: [project] };
  const cwds = (project: number | null): Seg[] => {
    const f = from(project);
    return [{
      has: (g) => g.project === project && isCwd(g, true),
      page: (after, n) => {
        const c = after?.at && 'cwd' in after.at ? after.at.cwd : null;
        return keys(`SELECT DISTINCT s.cwd AS k ${f.sql} AND s.repo_key IS NULL AND ${c === null ? 's.cwd IS NOT NULL' : 's.cwd > ?'} AND ${CWD_KNOWN} ORDER BY s.cwd LIMIT ?`,
          c === null ? f.args : [...f.args, c], n).map((r) => ({ project, at: { cwd: String(r.k) } }));
      },
    }, {
      has: (g) => g.project === project && isCwd(g, false),
      page: (after) => (after === null && db.prepare(`SELECT 1 ${f.sql} AND s.repo_key IS NULL AND ${CWD_UNKNOWN} LIMIT 1`).get(...f.args)
        ? [{ project, at: { cwd: null } }] : []),
    }];
  };
  if (parent === null) {
    const auto = from(null);
    return [{
      has: (g) => g.project !== null && g.at === null,
      page: (after, n) => {
        const f = from(after?.project ?? 0, '>');
        return keys(`SELECT DISTINCT o.project_id AS k ${f.sql} ORDER BY o.project_id LIMIT ?`, f.args, n).map((r) => ({ project: Number(r.k), at: null }));
      },
    }, {
      has: (g) => g.project === null && isRepo(g, false),
      page: (after, n) => {
        const k = after?.at && 'repo' in after.at ? after.at.repo : null;
        return keys(`SELECT DISTINCT s.repo_key AS k ${auto.sql} AND ${k === null ? 's.repo_key IS NOT NULL' : 's.repo_key > ?'} ORDER BY s.repo_key LIMIT ?`,
          k === null ? [] : [k], n).map((r) => ({ project: null, at: { repo: String(r.k), worktree: null } }));
      },
    }, ...cwds(null)];
  }
  if (parent.project === null && isRepo(parent, false)) {
    const repo = (parent.at as { repo: string }).repo;
    return [{
      has: (g) => g.project === null && isRepo(g, true) && (g.at as { repo: string }).repo === repo,
      page: (after, n) => {
        const w = after ? (after.at as { worktree: string }).worktree : null;
        return keys(`SELECT DISTINCT s.worktree AS k ${from(null).sql} AND s.repo_key = ? AND ${w === null ? 's.worktree IS NOT NULL' : 's.worktree > ?'} ORDER BY s.worktree LIMIT ?`,
          w === null ? [repo] : [repo, w], n).map((r) => ({ project: null, at: { repo, worktree: String(r.k) } }));
      },
    }];
  }
  if (parent.project !== null && parent.at === null) {
    const project = parent.project, f = from(project);
    return [{
      has: (g) => g.project === project && isRepo(g, true),
      page: (after, n) => {
        const a = after ? after.at as { repo: string; worktree: string } : null;
        // ponytail: sorts the project's own sessions per page (bounded by project size); index overlays by session key if projects grow huge
        return keys(`SELECT DISTINCT s.repo_key AS k, s.worktree AS w ${f.sql} AND s.worktree IS NOT NULL AND ${a === null ? 's.repo_key IS NOT NULL'
          : '(s.repo_key > ? OR (s.repo_key = ? AND s.worktree > ?))'} ORDER BY s.repo_key, s.worktree LIMIT ?`, a === null ? f.args : [...f.args, a.repo, a.repo, a.worktree], n)
          .map((r) => ({ project, at: { repo: String(r.k), worktree: String(r.w) } }));
      },
    }, ...cwds(project)];
  }
  return []; // worktrees and cwd folders hold sessions only
}

function node(db: DatabaseSync, g: MapGroup, live: LiveOf | undefined, now: number): MapNode {
  const { where, args } = groupWhere(g);
  const w = [...where, notPurging(db)].join(' AND '); // XAIBO-PROD-542: a purging session counts nowhere
  const a = db.prepare(`SELECT count(*) AS n, group_concat(DISTINCT s.agent) AS agents, group_concat(DISTINCT coalesce(s.repo_reason, '-')) AS reasons
    FROM sessions s ${OVERLAY} WHERE ${w}`).get(...args) as { n: number; agents: string | null; reasons: string | null };
  const recorded = new Set((a.reasons ?? '').split(','));
  const reasons = g.at !== null && 'cwd' in g.at ? [...REPO_REASONS.filter((r) => recorded.has(r)), ...(recorded.has('-') ? [null] : [])] : [];
  let liveN: number | null = null;
  // ponytail: one live() call per group session active in the last 24 h, per node (10–20 per page); keep a live set if pages slow
  if (live) { // the Dashboard's membership: engine status present and not ended, active within the live window
    liveN = 0;
    for (const k of db.prepare(`SELECT s.agent, s.profile_id, s.native_session_id FROM sessions s ${OVERLAY} WHERE ${w} AND s.last_activity >= ?`)
      .iterate(...args, now - LIVE_WINDOW_MS) as Iterable<{ agent: string; profile_id: string; native_session_id: string }>) {
      const st = live(k.agent, k.native_session_id, k.profile_id);
      if (st && st.lifecycle !== 'ended') liveN++;
    }
  }
  const project = g.project === null ? undefined : db.prepare('SELECT id, name FROM projects WHERE id = ?').get(g.project) as { id: number; name: string } | undefined;
  return { group: g, project: project ? { id: project.id, name: project.name } : null, reasons, sessions: a.n, live: liveN,
    agents: a.agents === null ? [] : a.agents.split(',').sort() };
}

/** A page of groups under `parent` (null = roots), after `cursor` (the previous page's last group); throws on a store error.
 *  A cursor from another parent matches no segment and gives an empty page. */
export function mapGroups(db: DatabaseSync, parent: MapGroup | null, cursor: MapGroup | null, limit: number, live?: LiveOf,
  now = Date.now()): { groups: MapNode[]; next: MapGroup | null } {
  const n = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : MAP_ROOTS, parent === null ? MAP_ROOTS : MAP_CHILDREN);
  const segs = segments(db, parent);
  let i = cursor ? segs.findIndex((s) => s.has(cursor)) : 0;
  const out: MapGroup[] = [];
  if (i >= 0) for (let after = cursor; i < segs.length && out.length < n; i++, after = null) out.push(...segs[i]!.page(after, n - out.length));
  return { groups: out.map((g) => node(db, g, live, now)), next: out.length === n ? out.at(-1)! : null };
}
