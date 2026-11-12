// Synthetic fixture lint (P1-T02, EC-62; stdlib only).
// Usage: fixture-lint.ts (tracked fixtures) | <dir> | --staged (staged fixtures)
// Every privacy-scan pattern (synthetic UUIDs only, example-domain emails, secrets, home paths, machine names),
// plus: absolute paths must sit under /tmp/xaibo-fixture/; home paths are written ~/…, project paths <project>/….
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { git, nulList, scanText } from './privacy-scan.ts';

const ROOT = 'test/fixtures/synthetic';
// Absolute POSIX paths with two or more segments (so `/compact` passes), file URLs, Windows drive paths.
// URL paths, `~/…`, `<project>/…` and relative paths are excluded by the lookbehind.
const ABS = /(?<![\w.~<>/:\\-])(?:\/[\w.-]+\/[^\s"'\\]*|file:\/\/[^\s"'\\]*)|(?<!\w)[A-Za-z]:\\{1,2}[\w.-]/g;
const FIXTURE_ROOT = /^\/tmp\/xaibo-fixture(\/|$)/;
// A line-1 shebang naming a standard interpreter (`#!/bin/sh`, `#!/usr/bin/env node`) is not machine data.
const SHEBANG = /^#!\/(?:usr\/)?bin\/[\w.-]+(?: [\w.-]+)?$/;

export function lintText(label: string, text: string): string[] {
  const out = scanText(label, text);
  text.split('\n').forEach((line, i) => {
    if (i === 0 && SHEBANG.test(line)) return;
    if ((line.match(ABS) ?? []).some((m) => !FIXTURE_ROOT.test(m.replace(/^file:\/\//, '')))) out.push(`${label}:${i + 1} fixture-path`);
  });
  return out;
}

const lintBuf = (label: string, buf: Buffer) => (buf.includes(0) ? [] : lintText(label, buf.toString('utf8')));
const walk = (p: string): string[] => (statSync(p).isDirectory() ? readdirSync(p).flatMap((e) => walk(path.join(p, e))) : [p]);

function main(arg?: string): number {
  const findings = arg === '--staged'
    ? nulList(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', '--', ROOT])).flatMap((f) => lintBuf(f, git(['show', `:${f}`])))
    : arg
      ? walk(arg).flatMap((f) => lintBuf(path.relative(process.cwd(), f) || f, readFileSync(f)))
      : nulList(git(['ls-files', '-z', '--', ROOT])).filter((f) => existsSync(f)).flatMap((f) => lintBuf(f, readFileSync(f)));
  for (const f of findings) console.log(f);
  return findings.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv[2]);
