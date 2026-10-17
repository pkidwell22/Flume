import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import manifest from '../sources/manifest.json' with { type: 'json' };

export function assertDigest(bytes: Uint8Array, expected: string): void {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('Public source digest mismatch; review and repin before using this contract');
  }
}

const h3Bytes = readFileSync(new URL('../sources/minimax-h3.json', import.meta.url));
assertDigest(h3Bytes, manifest.h3.sha256);
assertDigest(readFileSync(new URL('../sources/router-openapi.yaml', import.meta.url)), manifest.router.sha256);
export const h3Document = JSON.parse(h3Bytes.toString('utf8'));
