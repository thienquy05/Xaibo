// The one privacy/secret pattern list (P1-T03), used by scripts/privacy-scan.ts (repo gate) and sanitize() (egress).
// privacy-scan:allow pattern list
export const PATTERNS: readonly (readonly [id: string, re: RegExp])[] = [
  ['home-path', /(?<![A-Za-z0-9_.~-])(?:\/Users\/|\/private\/|\/home\/)|C:\\{1,2}Users\\{1,2}/i], // plain or JSON-escaped Windows
  ['uuid', /\b(?!00000000-0000-4000-8000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['email', /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net|invalid)\b)(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/],
  ['loopback-port', /(?:localhost|127\.0\.0\.1|\[::1\]):\d+/],
  ['secret-anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['secret-generic', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['secret-aws', /\bAKIA[0-9A-Z]{16}\b/],
  ['secret-github', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['secret-google', /\bAIza[0-9A-Za-z_-]{35}/],
  ['secret-slack', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['secret-jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['secret-bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['secret-pem', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['secret-userinfo', /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i],
];
