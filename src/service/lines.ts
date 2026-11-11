// Byte-level line splitting (P1-T09, EC-14): split on 0x0A before decoding, carry partial bytes across chunks.
export interface Line { bytes: Buffer; offset: number } // offset of the line's first byte; newline (and a trailing CR) excluded

export class LineSplitter {
  #parts: Buffer[] = []; // partial line, kept as chunks so a huge line is concatenated once
  #partsLength = 0;
  #start: number;

  constructor(startOffset = 0) { this.#start = startOffset; }

  /** Offset just after the last complete newline: the only safe checkpoint. */
  get committedOffset(): number { return this.#start; }
  get pendingBytes(): number { return this.#partsLength; }

  push(chunk: Buffer): Line[] {
    const out: Line[] = [];
    let from = 0;
    let nl: number;
    while ((nl = chunk.indexOf(0x0a, from)) !== -1) {
      const piece = chunk.subarray(from, nl);
      const bytes = this.#parts.length ? Buffer.concat([...this.#parts, piece]) : piece;
      const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
      out.push({ bytes: bytes.subarray(0, end), offset: this.#start });
      this.#start += bytes.length + 1;
      this.#parts = [];
      this.#partsLength = 0;
      from = nl + 1;
    }
    if (from < chunk.length) {
      this.#parts.push(Buffer.from(chunk.subarray(from))); // copy: the caller may reuse its read buffer
      this.#partsLength += chunk.length - from;
    }
    return out;
  }
}
