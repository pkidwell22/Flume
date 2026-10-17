import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { score } from './scorer.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node score.mjs RESPONSE.txt | -');
const text = readFileSync(process.argv[2] === '-' ? 0 : process.argv[2], 'utf8');
const load = name => JSON.parse(readFileSync(new URL(name, import.meta.url)));
const result = score(text, load('fixtures.json'), load('oracle.json'));
result.responseSha256 = createHash('sha256').update(text).digest('hex');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.summary.all === result.summary.cases ? 0 : 2;
