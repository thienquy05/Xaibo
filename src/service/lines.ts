// Byte-level line splitting (P1-T09, EC-14): split on 0x0A before decoding, carry partial bytes across chunks.
// P1-T14 (EC-15, OQ-P1-06): with a cap, a line longer than `maxLine` is never held in memory; pushPieces() streams it
// as start/data/end pieces, and the committed offset stays at its start until its newline arrives.
export interface Line { bytes: Buffer; offset: number } // offset of the line's first byte; newline (and a trailing CR) excluded
export type BigPiece = { big: 'start'; offset: number } | { big: 'data'; bytes: Buffer } | { big: 'end'; offset: number; length: number };
export type Piece = Line | BigPiece;

export class LineSplitter {
  #parts: Buffer[] = []; // partial line, kept as chunks so a huge line is concatenated once
  #partsLength = 0;
  #start: number;
  readonly #max: number;
  #big = false; // inside a line above the cap
  #bigLength = 0;

  constructor(startOffset = 0, o: { maxLine?: number } = {}) {
    this.#start = startOffset;
    this.#max = o.maxLine ?? Infinity;
  }

  /** Offset just after the last complete newline: the only safe checkpoint. */
  get committedOffset(): number { return this.#start; }
  get pendingBytes(): number { return this.#partsLength; }

  /** Complete lines only; for a splitter without a cap (a capped one must use pushPieces). */
  push(chunk: Buffer): Line[] {
    return this.pushPieces(chunk).map((p) => {
      if ('big' in p) throw new Error('line above the cap: use pushPieces');
      return p;
    });
  }

  pushPieces(chunk: Buffer): Piece[] {
    const out: Piece[] = [];
    let from = 0;
    while (from < chunk.length) {
      const nl = chunk.indexOf(0x0a, from);
      const end = nl === -1 ? chunk.length : nl;
      if (this.#big) {
        if (end > from) { out.push({ big: 'data', bytes: Buffer.from(chunk.subarray(from, end)) }); this.#bigLength += end - from; }
        if (nl === -1) break;
        out.push({ big: 'end', offset: this.#start, length: this.#bigLength });
        this.#start += this.#bigLength + 1;
        this.#big = false;
        from = nl + 1;
        continue;
      }
      const piece = chunk.subarray(from, end);
      if (this.#partsLength + piece.length > this.#max) { // becomes a big line: hand over what is buffered, stream the rest
        out.push({ big: 'start', offset: this.#start });
        for (const p of this.#parts) out.push({ big: 'data', bytes: p });
        if (piece.length) out.push({ big: 'data', bytes: Buffer.from(piece) });
        this.#bigLength = this.#partsLength + piece.length;
        this.#parts = [];
        this.#partsLength = 0;
        this.#big = true;
        from = end; // the newline (if any) is handled in big mode on the next pass
        continue;
      }
      if (nl === -1) {
        this.#parts.push(Buffer.from(piece)); // copy: the caller may reuse its read buffer
        this.#partsLength += piece.length;
        break;
      }
      const bytes = this.#parts.length ? Buffer.concat([...this.#parts, piece]) : piece;
      const len = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
      out.push({ bytes: bytes.subarray(0, len), offset: this.#start });
      this.#start += bytes.length + 1;
      this.#parts = [];
      this.#partsLength = 0;
      from = nl + 1;
    }
    return out;
  }
}
