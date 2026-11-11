// Oversized records (P1-T14; EC-15, FR-08, OQ-P1-06): a transcript line above the parse cap is read as a stream by a
// small validating JSON tokenizer. Readable fields (prompt, response, thinking, tool input and output, and the S9
// large-payload fields) become content chunks of at most `contentBytes` UTF-8 bytes, each one FTS item; the raw text is
// kept in `rawBytes` chunks; a head row carries the small fields. A syntax error stops extraction there: what was read
// stays, the rest is a gap. Memory stays O(contentBytes + rawBytes + 4 KiB) whatever the line size. Chunk ids hash
// the source file, the line's offset and its first 4 KiB, so any input chunking (and a reparse after a crash) gives the
// same ids.
// ponytail: chunk source_seq is the input position when the chunk started, exact only to one input piece.
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { INJECTED_PREFIXES, KNOWN_TYPES, type ClaudeRecord } from './parse.ts';

const KEY_BYTES = 4096;
const SMALL_MAX = 4096;
const KEY_MAX = 256;
const SMALL = new Set(['type', 'uuid', 'parentUuid', 'sessionId', 'timestamp', 'cwd', 'entrypoint', 'version', 'isSidechain', 'message.role', 'message.id', 'message.model']);
const READABLE = [
  /^message\.content$/, /^message\.content\.\[\]\.(text|thinking|content)$/, /^message\.content\.\[\]\.input(\.|$)/,
  /^message\.content\.\[\]\.content\.\[\]\.text$/, /^content$/, /^attachment\.content(\.|$)/, /^rendered\.\[\]\.content(\.|$)/,
  /^shape\.system\.\[\]\.text$/,
];
const FIRST_TEXT = /^message\.content(\.\[\]\.text)?$/;
const LITERAL = /^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)$/;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const STRING_STOP = /["\\\u0000-\u001f]/g;

type Frame = { t: 'o'; key: string; state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'commaOrEnd' } | { t: 'a'; state: 'valueOrEnd' | 'value' | 'commaOrEnd' };
type Target = 'readable' | 'small' | 'key' | 'skip';

const isHigh = (c: number) => c >= 0xd800 && c < 0xdc00;
const isLow = (c: number) => c >= 0xdc00 && c < 0xe000;
/** A high surrogate followed by a low one at i (a pair, 4 UTF-8 bytes); a lone surrogate is one unit of 3 bytes. */
const pairAt = (s: string, i: number) => isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1));
const unitBytes = (c: number) => (c < 0x80 ? 1 : c < 0x800 ? 2 : 3);
/** Length of the longest prefix of s within `room` UTF-8 bytes, never ending between a surrogate pair. */
function fit(s: string, room: number): number {
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const width = pairAt(s, i) ? 2 : 1;
    const b = width === 2 ? 4 : unitBytes(s.charCodeAt(i));
    if (bytes + b > room) break;
    bytes += b;
    i += width;
  }
  return i;
}

/** Accumulates text and cuts it into pieces of at most `max` UTF-8 bytes; `at` is the byte position of a piece's start.
 *  A trailing high surrogate is held until the next add, so a pair that arrives in two calls (`\uD83D` `\uDE00`
 *  escapes) is never cut apart. */
class Cutter {
  #buf = '';
  #bytes = 0;
  #at = 0;
  #high = '';
  #highAt = 0;
  readonly #max: number;
  readonly out: { text: string; at: number }[] = [];
  constructor(max: number) { this.#max = max; }
  add(s: string, at: number): void {
    if (this.#high) { s = this.#high + s; at = this.#highAt; this.#high = ''; }
    if (s && isHigh(s.charCodeAt(s.length - 1))) { this.#high = s.slice(-1); this.#highAt = at; s = s.slice(0, -1); }
    this.#put(s, at);
  }
  /** Emits everything held, a lone trailing high surrogate included. */
  flush(): void {
    const high = this.#high;
    this.#high = '';
    this.#put(high, this.#highAt);
    this.#cut();
  }
  #put(s: string, at: number): void {
    while (s.length) {
      if (!this.#buf) this.#at = at;
      const b = Buffer.byteLength(s);
      if (this.#bytes + b <= this.#max) { this.#buf += s; this.#bytes += b; return; }
      let n = fit(s, this.#max - this.#bytes);
      if (n === 0 && !this.#buf) n = pairAt(s, 0) ? 2 : 1; // one code point wider than the room: emit it alone
      this.#buf += s.slice(0, n);
      this.#cut();
      s = s.slice(n);
    }
  }
  #cut(): void {
    if (this.#buf) this.out.push({ text: this.#buf, at: this.#at });
    this.#buf = '';
    this.#bytes = 0;
  }
}

/** `source` names the file (its path): chunk ids are unique per session, and a session's transcript and subagent files
 *  can hold identical lines at the same offset. */
export interface OversizedOptions { offset: number; fileMtime: number; receivedTs: number; source?: string; subagentNativeId?: string | undefined; contentBytes?: number; rawBytes?: number }

export class OversizedRecord {
  readonly #o: OversizedOptions;
  readonly #decoder = new StringDecoder('utf8');
  readonly #content: Cutter;
  readonly #raw: Cutter;
  #head = Buffer.alloc(0); // the line's first KEY_BYTES, for the chunk key
  #key: string | undefined;
  #fed = 0; // bytes fed so far
  #rawAt = 0; // bytes of raw text taken so far
  #contentN = 0;
  #rawN = 0;
  // tokenizer
  #stack: Frame[] = [];
  #top: 'value' | 'done' = 'value';
  #mode: 'normal' | 'string' | 'escape' | 'unicode' | 'literal' | 'error' = 'normal';
  #target: Target = 'skip';
  #path = '';
  #str = '';
  #strOver = false;
  #hex = '';
  #literal = '';
  #fieldsEmitted = 0;
  readonly #fields = new Map<string, string | boolean>();
  #firstText: string | undefined;

  constructor(o: OversizedOptions) {
    this.#o = o;
    this.#content = new Cutter(o.contentBytes ?? 64 * 1024);
    this.#raw = new Cutter(o.rawBytes ?? 1 << 20);
  }

  feed(bytes: Buffer): ClaudeRecord[] {
    if (this.#head.length < KEY_BYTES) this.#head = Buffer.concat([this.#head, bytes.subarray(0, KEY_BYTES - this.#head.length)]);
    this.#fed += bytes.length;
    this.#take(this.#decoder.write(bytes));
    if (!this.#key && this.#head.length >= KEY_BYTES) this.#key = this.#keyOf();
    return this.#drain();
  }

  end(): { records: ClaudeRecord[]; unreadable: boolean } {
    this.#take(this.#decoder.end());
    if (this.#mode === 'literal') this.#endLiteral();
    const unreadable = this.#mode !== 'normal' || this.#top !== 'done';
    this.#content.flush();
    this.#raw.flush();
    this.#key ??= this.#keyOf();
    return { records: [...this.#drain(), this.#headRecord()], unreadable };
  }

  // The source file and the line's offset are part of the key: two records with the same first 4 KiB stay distinct,
  // in one file or in two files of one session (a shifted record in a rewritten file duplicates its chunks instead of
  // losing them).
  #keyOf() { return `x:${createHash('sha256').update(`${this.#o.source ?? ''}\0${this.#o.offset}:`).update(this.#head).digest('hex').slice(0, 16)}`; }

  #take(text: string): void {
    if (!text) return;
    this.#raw.add(text, this.#rawAt);
    this.#rawAt += Buffer.byteLength(text);
    let i = 0;
    while (i < text.length && this.#mode !== 'error') i = this.#step(text, i);
  }

  /** Processes text from i; returns the next position. */
  #step(s: string, i: number): number {
    switch (this.#mode) {
      case 'string': {
        STRING_STOP.lastIndex = i;
        const m = STRING_STOP.exec(s);
        const stop = m ? m.index : s.length;
        if (stop > i) this.#chars(s.slice(i, stop));
        if (!m) return s.length;
        if (s[stop] === '"') this.#endString();
        else if (s[stop] === '\\') this.#mode = 'escape';
        else this.#mode = 'error'; // a raw control character inside a string
        return stop + 1;
      }
      case 'escape': {
        const c = s[i]!;
        if (c === 'u') { this.#mode = 'unicode'; this.#hex = ''; }
        else if (c in ESCAPES) { this.#chars(ESCAPES[c]!); this.#mode = 'string'; }
        else this.#mode = 'error';
        return i + 1;
      }
      case 'unicode': {
        const c = s[i]!;
        if (!/[0-9a-fA-F]/.test(c)) { this.#mode = 'error'; return i + 1; }
        this.#hex += c;
        if (this.#hex.length === 4) { this.#chars(String.fromCharCode(parseInt(this.#hex, 16))); this.#mode = 'string'; }
        return i + 1;
      }
      case 'literal': {
        const c = s[i]!;
        if (/[-+.0-9a-zA-Z]/.test(c)) {
          this.#literal += c;
          if (this.#literal.length > 64) this.#mode = 'error';
          return i + 1;
        }
        this.#endLiteral();
        return i; // the delimiter is handled in normal mode
      }
      default: return this.#normal(s[i]!, i);
    }
  }

  #normal(c: string, i: number): number {
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') return i + 1;
    const f = this.#stack.at(-1);
    if (!f) {
      if (this.#top === 'done') { this.#mode = 'error'; return i + 1; }
      return this.#value(c, i);
    }
    if (f.t === 'o') {
      if (f.state === 'keyOrEnd' || f.state === 'key') {
        if (c === '"') { this.#startString('key'); return i + 1; }
        if (c === '}' && f.state === 'keyOrEnd') { this.#stack.pop(); this.#valueDone(); return i + 1; }
      } else if (f.state === 'colon') {
        if (c === ':') { f.state = 'value'; return i + 1; }
      } else if (f.state === 'value') return this.#value(c, i);
      else if (c === ',') { f.state = 'key'; return i + 1; }
      else if (c === '}') { this.#stack.pop(); this.#valueDone(); return i + 1; }
    } else {
      if (f.state === 'valueOrEnd' && c === ']') { this.#stack.pop(); this.#valueDone(); return i + 1; }
      if (f.state === 'value' || f.state === 'valueOrEnd') return this.#value(c, i);
      if (c === ',') { f.state = 'value'; return i + 1; }
      if (c === ']') { this.#stack.pop(); this.#valueDone(); return i + 1; }
    }
    this.#mode = 'error';
    return i + 1;
  }

  #value(c: string, i: number): number {
    if (c === '{') { this.#stack.push({ t: 'o', key: '', state: 'keyOrEnd' }); return i + 1; }
    if (c === '[') { this.#stack.push({ t: 'a', state: 'valueOrEnd' }); return i + 1; }
    const path = this.#stack.map((f) => (f.t === 'o' ? f.key : '[]')).join('.');
    if (c === '"') {
      this.#path = path;
      this.#startString(READABLE.some((r) => r.test(path)) ? 'readable' : SMALL.has(path) ? 'small' : 'skip');
      return i + 1;
    }
    if (/[-0-9tfn]/.test(c)) { this.#path = path; this.#literal = ''; this.#mode = 'literal'; return i; }
    this.#mode = 'error';
    return i + 1;
  }

  #startString(target: Target): void {
    this.#mode = 'string';
    this.#target = target;
    this.#str = '';
    this.#strOver = false;
    if (target === 'readable' && this.#fieldsEmitted++ > 0) this.#content.add('\n', this.#fed);
  }

  #chars(s: string): void {
    if (this.#target === 'readable') {
      this.#content.add(s, this.#fed);
      if (FIRST_TEXT.test(this.#path) && (this.#firstText ?? '').length < 64) this.#firstText = ((this.#firstText ?? '') + s).slice(0, 64);
    } else if (this.#target === 'small' || this.#target === 'key') {
      if (this.#str.length + s.length > (this.#target === 'key' ? KEY_MAX : SMALL_MAX)) this.#strOver = true;
      else this.#str += s;
    }
  }

  #endString(): void {
    this.#mode = 'normal';
    if (this.#target === 'key') {
      const f = this.#stack.at(-1) as Extract<Frame, { t: 'o' }>;
      f.key = this.#strOver ? '\u0000' : this.#str; // an overlong key matches no path
      f.state = 'colon';
      return;
    }
    if (this.#target === 'small' && !this.#strOver) this.#fields.set(this.#path, this.#str);
    this.#valueDone();
  }

  #endLiteral(): void {
    if (!LITERAL.test(this.#literal)) { this.#mode = 'error'; return; }
    this.#mode = 'normal';
    if (SMALL.has(this.#path) && (this.#literal === 'true' || this.#literal === 'false')) this.#fields.set(this.#path, this.#literal === 'true');
    this.#valueDone();
  }

  #valueDone(): void {
    const f = this.#stack.at(-1);
    if (!f) this.#top = 'done';
    else f.state = 'commaOrEnd';
  }

  #drain(): ClaudeRecord[] {
    if (!this.#key) return [];
    const key = this.#key;
    const base = { fileMtime: this.#o.fileMtime, receivedTs: this.#o.receivedTs, subagentNativeId: this.#o.subagentNativeId, parentNativeId: key, injected: false, isSidechain: false };
    const out: ClaudeRecord[] = [];
    for (const c of this.#content.out.splice(0)) {
      out.push({ ...base, type: 'content-chunk', kind: 'content-chunk', nativeId: `${key}#c${String(++this.#contentN).padStart(6, '0')}`, sourceSeq: this.#o.offset + c.at, content: c.text, raw: '' });
    }
    for (const c of this.#raw.out.splice(0)) {
      out.push({ ...base, type: 'raw-chunk', kind: 'raw-chunk', nativeId: `${key}#r${String(++this.#rawN).padStart(6, '0')}`, sourceSeq: this.#o.offset + c.at, raw: c.text });
    }
    return out;
  }

  #headRecord(): ClaudeRecord {
    const s = (k: string) => { const v = this.#fields.get(k); return typeof v === 'string' ? v : undefined; };
    const type = s('type') ?? '';
    const role = s('message.role');
    const ts = Date.parse(s('timestamp') ?? '');
    return {
      type, kind: !KNOWN_TYPES.has(type) ? 'unknown' : type === 'user' || type === 'assistant' ? 'message' : type,
      nativeId: s('uuid') ?? this.#key!, parentNativeId: s('parentUuid'), sessionId: s('sessionId'), sourceSeq: this.#o.offset,
      sourceTs: Number.isNaN(ts) ? undefined : ts, fileMtime: this.#o.fileMtime, receivedTs: this.#o.receivedTs,
      cwd: s('cwd'), entrypoint: s('entrypoint'), version: s('version'), role, messageId: s('message.id'), model: s('message.model'),
      injected: role === 'user' && INJECTED_PREFIXES.some((p) => (this.#firstText ?? '').trimStart().startsWith(p)),
      isSidechain: this.#fields.get('isSidechain') === true, subagentNativeId: this.#o.subagentNativeId, raw: '', ingestId: this.#key!,
    };
  }
}
