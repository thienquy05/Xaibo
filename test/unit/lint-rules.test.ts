// P1-T01: the src/ lint policy (no network modules or globals, no HTML injection,
// no spike imports, child_process only in the sanctioned spawn module).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function ruleIds(code: string, file = 'src/service/sample.ts'): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(root, file) });
  assert.ok(result, 'no lint result');
  assert.equal(result.messages.filter((m) => m.fatal).length, 0, JSON.stringify(result.messages));
  return result.messages.map((m) => m.ruleId ?? 'none');
}

const cases: Array<[string, string, string, string?]> = [
  ['global fetch', "fetch('x');\n", 'no-restricted-globals'],
  ['WebSocket global', "new WebSocket('x');\n", 'no-restricted-globals'],
  ['globalThis.fetch', "globalThis.fetch('x');\n", 'no-restricted-syntax'],
  ['session.fetch', "declare const session: any;\nsession.fetch('x');\n", 'no-restricted-syntax'],
  ['import http', "import http from 'http';\nvoid http;\n", 'no-restricted-imports'],
  ['import node:net', "import net from 'node:net';\nvoid net;\n", 'no-restricted-imports'],
  ['import undici', "import { request } from 'undici';\nvoid request;\n", 'no-restricted-imports'],
  ['dynamic import node:https', "await import('node:https');\n", 'no-restricted-syntax'],
  ['require dns', "declare const require: any;\nrequire('dns');\n", 'no-restricted-syntax', 'src/main/preload.cts'],
  ['Electron net', "import { net } from 'electron';\nvoid net;\n", 'no-restricted-imports', 'src/main/index.ts'],
  ['electron.net member', "import electron from 'electron';\nvoid electron.net;\n", 'no-restricted-syntax', 'src/main/index.ts'],
  ['innerHTML assignment', "declare const el: any;\nel.innerHTML = 'x';\n", 'no-restricted-syntax', 'src/renderer/text.ts'],
  ['outerHTML', "declare const el: any;\nel.outerHTML = 'x';\n", 'no-restricted-syntax', 'src/renderer/text.ts'],
  ['insertAdjacentHTML', "declare const el: any;\nel.insertAdjacentHTML('beforeend', 'x');\n", 'no-restricted-syntax', 'src/renderer/text.ts'],
  ['dangerouslySetInnerHTML', "export const A = () => <div dangerouslySetInnerHTML={{ __html: 'x' }} />;\n", 'no-restricted-syntax', 'src/renderer/A.tsx'],
  ['spikes import', "import { x } from '../../spikes/s1/db.ts';\nvoid x;\n", 'no-restricted-imports'],
  ['child_process outside spawn module', "import { execFile } from 'node:child_process';\nvoid execFile;\n", 'no-restricted-imports'],
  ['dynamic child_process outside spawn module', "await import('child_process');\n", 'no-restricted-syntax'],
  ['network import inside spawn module', "import http from 'node:http';\nvoid http;\n", 'no-restricted-imports', 'src/service/spawn.ts'],
];

for (const [name, code, rule, file] of cases) {
  test(`flags ${name}`, async () => {
    assert.ok((await ruleIds(code, file)).includes(rule), `${name}: expected ${rule}`);
  });
}

test('allows child_process in the sanctioned spawn module', async () => {
  assert.deepEqual(await ruleIds("import { execFile } from 'node:child_process';\nvoid execFile;\n", 'src/service/spawn.ts'), []);
});

test('clean sample has no findings', async () => {
  const code = "import { readFile } from 'node:fs/promises';\nimport { app } from 'electron';\n" +
    "export const network = 1;\nexport async function f(p: string) { void app; return readFile(p, 'utf8'); }\n";
  assert.deepEqual(await ruleIds(code, 'src/main/index.ts'), []);
  assert.deepEqual(await ruleIds("export const A = (p: { t: string }) => <p>{p.t}</p>;\n", 'src/renderer/A.tsx'), []);
});

test('rules apply to src/ only', async () => {
  assert.deepEqual(await ruleIds("import { execFile } from 'node:child_process';\nvoid execFile;\n", 'scripts/sample.ts'), []);
});
