// Canary secrets generated in memory per pattern class (P1-T03, EC-33/EC-35). Never written to git.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', az = 'abcdefghijklmnopqrstuvwxyz', D = '0123456789';
const rnd = (len: number, alphabet: string) => Array.from(randomBytes(len), (b) => alphabet[b % alphabet.length]).join('');
const mixed = (len: number) => `Ab1${rnd(len - 3, AZ + az + D)}`;

/** One fresh canary per `secret-*` pattern id, plus `home` (a path under the real home dir) and `email`. */
export function canaries(): Record<string, string> {
  return {
    'secret-anthropic': `sk-ant-api03-${mixed(40)}`,
    'secret-generic': `sk-${mixed(32)}`,
    'secret-aws': `AKIA${rnd(16, AZ + D)}`,
    'secret-github': `ghp_${mixed(36)}`,
    'secret-google': `AIza${mixed(35)}`,
    'secret-slack': `xoxb-${rnd(12, D)}-${rnd(12, D)}-${mixed(24)}`,
    'secret-jwt': `eyJ${mixed(20)}.eyJ${mixed(20)}.${mixed(20)}`,
    'secret-bearer': `Bearer ${mixed(30)}`,
    'secret-pem': ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
    'secret-userinfo': `https://user:${rnd(10, az)}@host.example.org/`,
    home: `${homedir()}/${rnd(8, az)}/notes.txt`,
    email: `${rnd(6, az)}@${rnd(8, az)}.com`,
  };
}
