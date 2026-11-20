// Trained policies for tests: the game's own (public/ai/, through its manifest) and the fixtures (test/fixtures/).
import { readFileSync } from 'node:fs';
import type { CarId } from '../src/cars';
import { parsePolicy, pickPolicy, type Policy } from '../src/ai/policy';

export const fileBuffer = (name: string) => { const b = readFileSync(name); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };

// The policy the game drives `car` at `track` with (public/ai/policies.json), and its file name; null if the manifest
// names none (none is installed until one is trained on the current observation: the tests that need one skip).
export function gamePolicy(car: CarId, track: string): { file: string; policy: Policy } | null {
  const file = pickPolicy(JSON.parse(readFileSync('public/ai/policies.json', 'utf8')), car, track);
  return file ? { file, policy: parsePolicy(fileBuffer(`public/ai/${file}`)) } : null;
}
export const noGamePolicy = (car: CarId, track: string) => `no trained policy for ${car} at ${track} in public/ai/policies.json (install one after training: docs/ai-env.md)`;
