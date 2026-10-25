import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID: 48-bit millisecond time + 80 random bits, Crockford base32, lexicographically sortable. */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] ?? 0) % 32];
  return time + rand;
}

/** Prefixed lowercase id, safe as a cross-platform folder name, e.g. `shot_01jb…`. */
export const newId = (prefix: string, now?: number): string => `${prefix}_${ulid(now).toLowerCase()}`;
