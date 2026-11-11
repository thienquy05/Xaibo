// Untrusted strings as visible text (P1-T12, EC-55, SEC3). React renders them as text nodes, so markup stays literal;
// this makes the characters that could still mislead visible: C0/C1 controls and DEL (ANSI escapes, newlines) as
// \xHH, and bidi embedding/override/isolate controls as \uHHHH, so they cannot style or reorder what is shown.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI = /[‪-‮⁦-⁩]/g;
const hex = (c: string, width: number) => c.charCodeAt(0).toString(16).toUpperCase().padStart(width, '0');

export const visible = (s: string): string =>
  s.replace(CONTROL, (c) => `\\x${hex(c, 2)}`).replace(BIDI, (c) => `\\u${hex(c, 4)}`);
