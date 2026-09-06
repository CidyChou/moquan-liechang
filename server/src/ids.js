import { randomBytes } from 'node:crypto';

export function randomId(prefix = 'id') {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function randomSeed() {
  return randomBytes(4).readUInt32BE(0);
}
