// XAIBO-PROD-528 (P5-T18 part 2; design §6.6, §5.1, US-6, FR-11/FR-12; look D-P5-09): logic for the Settings Session
// retention, Trash and Storage sections. The stored setting picks the radio (unreadable picks none); Other takes a whole
// number of days 1..RETENTION_MAX and an out-of-range value is an error, never clamped; storage parts are shares of the
// reported total (database categories: of the database pages), and an unmeasured part is Unavailable with no share.
import { RETENTION_MAX, type RetentionSetting, type SAVE_RESULTS, type StorageReport } from '../../shared/ipc.ts';
import { formatTime } from '../model.ts';

export const DEFAULT_DAYS = 45;
export type Choice = 'default' | 'never' | 'other';
export interface Draft { choice: Choice | null; days: string }

export function draftOf(s: RetentionSetting | null): Draft {
  if (s === null) return { choice: null, days: '' };
  if (s === 'never') return { choice: 'never', days: '' };
  return s.days === DEFAULT_DAYS ? { choice: 'default', days: '' } : { choice: 'other', days: String(s.days) };
}

export const RANGE_ERROR = `Enter a whole number of days from 1 to ${RETENTION_MAX}.`;
export function settingOf(d: Draft): { value: RetentionSetting } | { error: string } {
  if (d.choice === null) return { error: 'Choose how long to keep inactive history.' };
  if (d.choice === 'default') return { value: { days: DEFAULT_DAYS } };
  if (d.choice === 'never') return { value: 'never' };
  const s = d.days.trim();
  const n = /^\d{1,5}$/.test(s) ? Number(s) : NaN;
  return n >= 1 && n <= RETENTION_MAX ? { value: { days: n } } : { error: RANGE_ERROR };
}

export type SavePhase = (typeof SAVE_RESULTS)[number] | 'applying' | 'unavailable' | null;
export function saveText(p: SavePhase): string {
  switch (p) {
    case null: return '';
    case 'applying': return 'Saving…';
    case 'saved': return 'Saved.';
    case 'invalid': return 'Not saved: the service did not accept this value.';
    case 'read-only': return 'Not saved: the store is read-only.';
    case 'disk-full': return 'Not saved: the disk is full.';
    case 'failed': return 'Not saved. Nothing was changed.';
    case 'unavailable': return 'The result is unavailable. Reopen Settings to see the saved value.';
  }
}

/** undefined = unknown (the setting was never read), null = no run yet (review L1). */
export const lastRunText = (at: number | null | undefined) =>
  at === undefined ? 'Last retention run: Unavailable' : at === null ? 'No retention run yet.' : `Last retention run: ${formatTime(at)}`;

/** The Session retention section's state (security review of run 159: M1, L1-L4). `pending` is the Save to send; a
 *  reply counts only for the latest Save (seq). `focus` asks the component to focus the invalid control after the
 *  error has rendered; n changes on every failed Save. */
export interface RetentionState {
  loaded: { setting: RetentionSetting | null; lastRunAt: number | null | undefined } | 'loading' | 'failed';
  draft: Draft;
  touched: boolean;
  error: string | null;
  announce: string;
  phase: SavePhase;
  seq: number;
  pending: { seq: number; value: RetentionSetting } | null;
  focus: { target: 'days' | 'first'; n: number } | null;
}
export type RetentionAction =
  | { type: 'loaded'; setting: RetentionSetting | null; lastRunAt: number | null }
  | { type: 'loadFailed' }
  | { type: 'change'; draft: Draft }
  | { type: 'blur' }
  | { type: 'save' }
  | { type: 'saved'; seq: number; result: (typeof SAVE_RESULTS)[number] | 'unavailable' };

export const initialRetention: RetentionState = {
  loaded: 'loading', draft: { choice: null, days: '' }, touched: false, error: null, announce: '', phase: null, seq: 0, pending: null, focus: null,
};

export function retentionReducer(s: RetentionState, a: RetentionAction): RetentionState {
  switch (a.type) {
    case 'loaded': // a late reply never overwrites what the user already chose (L3)
      return { ...s, loaded: { setting: a.setting, lastRunAt: a.lastRunAt }, draft: s.touched ? s.draft : draftOf(a.setting) };
    case 'loadFailed': return { ...s, loaded: 'failed' };
    case 'change': {
      if (s.phase === 'applying') return s; // the choice is frozen while a Save is applying (M1)
      const r = settingOf(a.draft);
      return { ...s, draft: a.draft, touched: true, phase: null, announce: '', error: s.error === null ? null : 'error' in r ? r.error : null };
    }
    case 'blur': {
      const r = settingOf(s.draft);
      return s.draft.choice === 'other' && 'error' in r && r.error !== s.error ? { ...s, error: r.error, announce: r.error } : s;
    }
    case 'save': {
      if (s.phase === 'applying') return s;
      const r = settingOf(s.draft);
      if ('error' in r) {
        return { ...s, error: r.error, announce: '', phase: null, focus: { target: s.draft.choice === 'other' ? 'days' : 'first', n: (s.focus?.n ?? 0) + 1 } };
      }
      const seq = s.seq + 1;
      return { ...s, error: null, announce: '', phase: 'applying', seq, pending: { seq, value: r.value } };
    }
    case 'saved': {
      if (a.seq !== s.seq || !s.pending) return s; // a reply for an older Save changes nothing (M1)
      const value = s.pending.value;
      const loaded = a.result !== 'saved' ? s.loaded
        : { setting: value, lastRunAt: typeof s.loaded === 'object' ? s.loaded.lastRunAt : undefined };
      return { ...s, phase: a.result, pending: null, loaded };
    }
  }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
/** Decimal units with three significant digits; a value that rounds to 1000 of a unit moves to the next one. */
export function formatBytes(n: number): string {
  let v = n, u = 0;
  while (u < UNITS.length - 1 && Number(v.toPrecision(3)) >= 1000) { v /= 1000; u++; }
  return `${u === 0 ? Math.round(v) : Number(v.toPrecision(3))} ${UNITS[u]}`;
}

export type StorageReply = { report: StorageReport | null; failed: boolean };
/** Opening or Refresh asks for a measurement: refresh=false only returns the last one (none after a start). The service
 *  measures at most once a minute and answers with the last report inside that minute. A lost reply is a failure. */
export const measureStorage = (api: { storage(refresh: boolean): Promise<StorageReply> }): Promise<StorageReply> =>
  api.storage(true).catch(() => ({ report: null, failed: true }));

/** Re-review L-A: the Save to send now: the reducer's own pending Save, once per seq (`sent` = the last seq sent). */
export const toSend = (s: RetentionState, sent: number) => s.pending && s.pending.seq !== sent ? s.pending : null;

/** The line under the total; a failed refresh that still carries the last report says how old it is (review L5). */
export function storageWhen(r: StorageReply): string {
  const when = r.report ? formatTime(r.report.measuredAt) : null;
  if (r.failed) return when ? `Storage could not be measured. Showing the measurement from ${when}.` : 'Storage could not be measured.';
  return when ? `Measured ${when}` : 'Not measured';
}

export interface StorageRow { key: string; label: string; text: string; share: number | null }
export interface StorageView { total: string; disk: StorageRow[]; inside: StorageRow[] | null }

const DISK = [['database', 'Database'], ['wal', 'Write-ahead log'], ['contentChunks', 'Content files'], ['spool', 'Spool'], ['backups', 'Backups']] as const;
const INSIDE = [['content', 'Sessions and content'], ['search', 'Search index'], ['usage', 'Usage, context and cost'], ['prices', 'Prices'],
  ['other', 'Other'], ['free', 'Free space (reusable)']] as const;

const row = (key: string, label: string, bytes: number | null, of: number | null): StorageRow =>
  ({ key, label, text: bytes === null ? 'Unavailable' : formatBytes(bytes), share: bytes === null || !of ? null : bytes / of * 100 });

export function storageView(r: StorageReport | null): StorageView {
  if (!r) return { total: 'Unavailable', disk: [], inside: null };
  const db = r.database;
  return {
    total: r.total === null ? 'Unavailable' : formatBytes(r.total),
    disk: DISK.map(([k, label]) => row(k, label, r.files[k], r.total)),
    inside: db ? INSIDE.map(([k, label]) => row(k, label, db.categories[k], db.bytes)) : null,
  };
}
