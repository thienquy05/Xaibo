// XAIBO-PROD-560 (P6-T03 part 2b; moved from the P3-T05 plugin test): a fake `claude` for the plugin route. It records each
// argv (fake-claude.log), its whole environment and cwd (fake-claude.env), and plays the S4 effects on the temp profile:
// marketplace add/remove edit plugins/known_marketplaces.json, install/uninstall edit plugins/installed_plugins.json and
// settings.json enabledPlugins. Modes (fake-claude.mode beside the config dir): fail-install, fail-dirty, no-enable,
// bump-retention (install also sets cleanupPeriodDays 50), slow (install waits 400 ms), touch-self (marketplace add edits
// this executable), snapshot (copies the manifest named in fake-claude.data at marketplace add), residue, empty-left,
// keep-registries; part 2c: uninstall deletes only our enabledPlugins key and rewrites settings compactly (a formatting
// change: byte identity must come from Xaibo's restore), install-0600 (install leaves settings at 0600), realpath-source (the
// marketplace registry stores the realpath of the plugin dir), drop-foreign / add-benign (uninstall also deletes `theme` /
// adds `cliAdded`). Synthetic temp profiles only.
import { writeFileSync } from 'node:fs';

export const FAKE_CLAUDE = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), dir = process.env.CLAUDE_CONFIG_DIR, side = path.dirname(dir);
fs.appendFileSync(path.join(side, 'fake-claude.log'), JSON.stringify({ argv: a, dir }) + '\\n');
fs.appendFileSync(path.join(side, 'fake-claude.env'), JSON.stringify({ keys: Object.keys(process.env).sort(), env: process.env, cwd: process.cwd() }) + '\\n');
const mode = fs.existsSync(path.join(side, 'fake-claude.mode')) ? fs.readFileSync(path.join(side, 'fake-claude.mode'), 'utf8').trim() : '';
const s = path.join(dir, 'settings.json'), plugins = path.join(dir, 'plugins');
const reg = (f, k, v) => { if (mode === 'keep-registries') return; fs.mkdirSync(plugins, { recursive: true }); const p = path.join(plugins, f); const o = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}; if (v === undefined) delete o[k]; else o[k] = v; fs.writeFileSync(p, JSON.stringify(o)); };
const cmd = a.join(' ');
if (a[0] === 'plugin' && a[1] === 'marketplace' && a[2] === 'add') {
  if (mode === 'snapshot') { const m = path.join(fs.readFileSync(path.join(side, 'fake-claude.data'), 'utf8'), 'integrations', 'manifest.json'); if (fs.existsSync(m)) fs.copyFileSync(m, path.join(side, 'fake-claude.manifest')); }
  reg('known_marketplaces.json', 'xaibo', { source: { source: 'directory', path: mode === 'realpath-source' ? fs.realpathSync(a[3]) : a[3] } });
  if (mode === 'touch-self') fs.appendFileSync(process.argv[1], '// touched\\n');
}
if (cmd === 'plugin marketplace remove xaibo') reg('known_marketplaces.json', 'xaibo', undefined);
if (cmd === 'plugin install xaibo-hooks@xaibo -s user') {
  if (mode === 'fail-install') process.exit(1);
  if (mode === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  reg('installed_plugins.json', 'xaibo-hooks@xaibo', [{ scope: 'user' }]);
  const o = fs.existsSync(s) ? JSON.parse(fs.readFileSync(s, 'utf8')) : {};
  if (mode !== 'no-enable') o.enabledPlugins = { ...(o.enabledPlugins || {}), 'xaibo-hooks@xaibo': true };
  if (mode === 'bump-retention') o.cleanupPeriodDays = 50;
  fs.writeFileSync(s, JSON.stringify(o, null, 2));
  if (mode === 'install-0600') fs.chmodSync(s, 0o600);
  if (mode === 'fail-dirty') process.exit(1); // failed after changing the profile
}
if (cmd === 'plugin uninstall xaibo-hooks@xaibo -s user') {
  if (mode === 'residue') process.exit(0);
  reg('installed_plugins.json', 'xaibo-hooks@xaibo', undefined);
  if (fs.existsSync(s)) {
    const o = JSON.parse(fs.readFileSync(s, 'utf8'));
    if (o.enabledPlugins) delete o.enabledPlugins['xaibo-hooks@xaibo'];
    if (mode === 'drop-foreign') delete o.theme;
    if (mode === 'add-benign') o.cliAdded = true;
    fs.writeFileSync(s, JSON.stringify(o)); // compact: the CLI's own formatting
  }
}
`;

/** Writes the fake as an executable file. */
export const writeFakeClaude = (file: string) => writeFileSync(file, FAKE_CLAUDE, { mode: 0o755 });

/** The Connect context's route inputs for synthetic worlds: `fallback` (the default) qualifies only the settings fallback from
 *  2.1.319 (so the part 1 cases keep their route), `plugin` uses the bundled catalog (D-P6-07); `exe` is the detected
 *  executable (its stat identity is recorded as detection does); version null = no version read. */
export async function claudeContext(o: { route?: 'plugin' | 'fallback'; version?: string | null; exe?: string; manual?: boolean } = {}) {
  const { realpathSync, statSync } = await import('node:fs');
  const { loadCatalog } = await import('../../src/service/catalog/validate.ts');
  const cat = loadCatalog();
  const catalog = o.route === 'plugin' ? cat : {
    ...cat, agents: cat.agents.map((a) => (a.id === 'claude' ? { ...a, connectRoutes: [{ route: 'claude-settings-fallback' as const, versions: { min: '2.1.319' }, evidence: 'fixture' }] } : a)),
  };
  const exe = o.exe ?? process.execPath;
  const st = statSync(exe);
  const det = { agent: 'claude', state: 'detected' as const, path: realpathSync(exe), manual: o.manual ?? false, version: o.version === undefined ? (o.route === 'plugin' ? '2.1.319' : '2.1.320') : o.version,
    id: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs } };
  return { catalog, detection: (agent: string) => (agent === 'claude' ? det : undefined), cliPath: '/usr/bin:/bin' as string | null };
}
