// XAIBO-PROD-617 (P7-T09; SEC1): Open in VS Code. The URL is built only from a lowercase UUID session id; the SEC1
// shell.openExternal allowlist admits exactly vscode://anthropic.claude-code/open?session=<uuid> (and nothing else); the
// injected opener receives that exact URL. A refused id or URL never reaches the opener.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedExternal, openInVsCode, vscodeUrl } from '../../../src/main/launch/vscode.ts';

const ID = '00000000-0000-4000-8000-0000000b7c06';
const URL_OK = `vscode://anthropic.claude-code/open?session=${ID}`;

test('a valid id opens the exact allowlisted URL', async () => {
  const got: string[] = [];
  assert.equal(vscodeUrl(ID), URL_OK);
  assert.equal(await openInVsCode(ID, async (u) => { got.push(u); }), 'opened');
  assert.deepEqual(got, [URL_OK]);
  assert.equal(await openInVsCode(ID, async () => { throw new Error('no handler'); }), 'failed');
});

test('a non-UUID id is refused before the opener; only the exact vscode: URL passes the allowlist', async () => {
  let calls = 0;
  for (const bad of [ID.toUpperCase(), `${ID}&x=1`, `${ID}\n`, '../x', '', `${ID}#`, `-${ID}`]) {
    assert.equal(vscodeUrl(bad), null, JSON.stringify(bad));
    assert.equal(await openInVsCode(bad, async () => { calls++; }), 'invalid');
  }
  assert.equal(calls, 0);
  assert.equal(allowedExternal(URL_OK), true);
  for (const u of ['https://example.invalid/', 'file:///etc/passwd', 'javascript:alert(1)', `vscode://other.ext/open?session=${ID}`, `vscode://anthropic.claude-code/run?session=${ID}`,
    `vscode://anthropic.claude-code/open?session=${ID}&cmd=x`, `vscode://anthropic.claude-code/open?session=${ID}#f`,    `VSCODE://anthropic.claude-code/open?session=${ID}`, `vscode://anthropic.claude-code:1/open?session=${ID}`, 'vscode://anthropic.claude-code/open?session=x']) assert.equal(allowedExternal(u), false, u);
});
