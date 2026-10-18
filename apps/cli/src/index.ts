import { parseArgs } from 'node:util';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FlumeClient, FlumeClientError, MAX_UPLOAD_BYTES } from '@flume/client';
import { AgentCommandSchema } from '@flume/domain';

export const CLI_USAGE = `Flume headless client (JSON output)
  flume [--base-url ORIGIN] [--timeout-ms N] projects
  flume [--base-url ORIGIN] workspace [projectId]
  flume [--base-url ORIGIN] command <file.json|->
  flume [--base-url ORIGIN] upload <projectId> <local-file>
  flume id

Commands use the canonical type/commandId JSON envelope. Keep the exact JSON and
UUID for explicit retries; this CLI never retries or approves a generation.
Approve the reviewed intent in the operator workspace. FLUME_API_URL may set the
server origin; credentials/actor claims are not accepted in CLI flags or JSON.
`;
export interface CliIO {
  stdin: AsyncIterable<Uint8Array | string>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
}
class UsageError extends Error {}
async function readBounded(input: AsyncIterable<Uint8Array | string>, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const data of input) {
    const chunk = Buffer.from(data); size += chunk.byteLength;
    if (size > maximum) throw new UsageError('Input exceeds the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readLocalFile(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new UsageError('A bounded regular local file is required');
    return await readBounded(handle.createReadStream({ autoClose: false }), maximum);
  } finally { await handle.close(); }
}
function mime(path: string): string {
  const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export async function runCli(argv: string[], io: CliIO = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env }): Promise<number> {
  try {
    let args: ReturnType<typeof parseArgs>;
    try { args = parseArgs({ args: argv, strict: true, allowPositionals: true, options: { 'base-url': { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean', short: 'h' } } }); }
    catch { throw new UsageError('Invalid arguments; use --help (credentials and actor flags are not supported)'); }
    if (args.values.help || args.positionals.length === 0) { io.stdout.write(CLI_USAGE); return 0; }
    const timeout = args.values['timeout-ms'];
    const baseUrl = args.values['base-url'] ?? io.env.FLUME_API_URL;
    if ((baseUrl !== undefined && typeof baseUrl !== 'string') || (timeout !== undefined && (typeof timeout !== 'string' || !/^[1-9]\d*$/.test(timeout)))) throw new UsageError('Invalid server origin or timeout');
    const client = new FlumeClient({ ...(baseUrl === undefined ? {} : { baseUrl }), ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }) });
    const [action, ...positionals] = args.positionals;
    let result: unknown;
    if (action === 'id' && positionals.length === 0) result = { commandId: randomUUID() };
    else if (action === 'projects' && positionals.length === 0) result = await client.listProjects();
    else if (action === 'workspace' && positionals.length <= 1) result = await client.getWorkspace(positionals[0]);
    else if (action === 'command' && positionals.length === 1) {
      let input: unknown;
      try { input = JSON.parse((await (positionals[0] === '-' ? readBounded(io.stdin, 1024 * 1024) : readLocalFile(positionals[0]!, 1024 * 1024))).toString('utf8')); }
      catch { throw new UsageError('Command input must be bounded valid JSON'); }
      if (typeof input === 'object' && input !== null && 'type' in input && input.type === 'generation.approve') throw new UsageError('Approval requires the operator workspace');
      const parsed = AgentCommandSchema.safeParse(input);
      if (!parsed.success) throw new UsageError('Invalid command; use the exact canonical schema and a UUID commandId');
      result = await client.command(parsed.data);
    } else if (action === 'upload' && positionals.length === 2) {
      const path = positionals[1]!;
      const bytes = await readLocalFile(path, MAX_UPLOAD_BYTES);
      result = await client.uploadAsset(positionals[0]!, new Blob([new Uint8Array(bytes)], { type: mime(path) }), basename(path));
    } else throw new UsageError('Unknown command or wrong arguments; use --help');
    io.stdout.write(`${JSON.stringify(result)}\n`); return 0;
  } catch (error) {
    if (error instanceof FlumeClientError) {
      io.stderr.write(`${JSON.stringify({ code: error.code, message: error.message, status: error.status, currentRevision: error.currentRevision, outcomeUnknown: error.outcomeUnknown })}\n`);
      return 1;
    }
    io.stderr.write(`${JSON.stringify({ code: 'invalid_input', message: error instanceof UsageError ? error.message : 'Invalid input or unavailable local file/server' })}\n`);
    return 2;
  }
}
