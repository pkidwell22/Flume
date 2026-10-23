import { spawn } from 'node:child_process';
import { MediaError } from './types.ts';
import type { Limits } from './types.ts';
const activeChildren=new Set<ReturnType<typeof spawn>>();
let cancelled=false;
/** Worker-isolate cancellation hook. Call only when abandoning every media operation in that worker. */
export async function cancelMediaProcesses(){
  cancelled=true;
  await Promise.all([...activeChildren].map(child=>new Promise<void>(resolve=>{
    if(child.exitCode!==null||child.signalCode!==null)return resolve();
    child.once('close',()=>resolve());child.kill('SIGKILL');
  })));
}

// Internal only: public operations select typed profiles, never caller argv/filtergraphs.
export type DiagnosticPolicy = 'strict' | 'full-range-jpeg-conversion' | 'software-rgb-conversion';
// Exit-zero stderr is a failed clean decode unless every line is the single documented notice of
// the selected conversion pass. Patterns are anchored: mixed, extended, or near-miss diagnostics
// (any other scaler direction, extra text, second message) stay fatal.
const toleratedDiagnostics: Partial<Record<DiagnosticPolicy, RegExp>> = {
  // FFmpeg 9 emits this API-deprecation notice even when JPEG full range is explicitly set.
  'full-range-jpeg-conversion': /^\[swscaler @ 0x[0-9a-f]+\] deprecated pixel format used, make sure you did set range correctly$/,
  // FFmpeg 7 arm64 has no accelerated yuv420p->rgb24 colorspace conversion, so swscale falls back
  // to software and logs exactly this. Only the RGB hash pass after a separate strict native
  // decode may accept it; the native decode itself is never relaxed.
  'software-rgb-conversion': /^\[swscaler @ 0x[0-9a-f]+\] No accelerated colorspace conversion found from yuv420p to rgb24\.$/,
};
export async function run(executable: string, args: readonly string[], limits: Limits, cwd: string, diagnosticPolicy: DiagnosticPolicy = 'strict'): Promise<Buffer> {
  if(cancelled)throw new MediaError('PROCESS_CANCELLED');
  const child = spawn(executable, [...args], {
    shell: false, cwd, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TMPDIR: cwd },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  const stdout: Buffer[] = [], stderr: Buffer[] = []; let outBytes = 0, errBytes = 0;
  let failure: MediaError | undefined;
  const stop = (code: string) => { failure ??= new MediaError(code); child.kill('SIGKILL'); };
  child.stdout.on('data', (b: Buffer) => {
    outBytes += b.length;
    if (outBytes > limits.maxProcessOutputBytes) stop('PROCESS_OUTPUT_LIMIT');
    else stdout.push(b);
  });
  // Even exit-zero warnings are a failed clean decode. Do not leak private paths/URLs via stderr.
  child.stderr.on('data', (b: Buffer) => { errBytes += b.length; if (errBytes > 65_536) stop('PROCESS_DIAGNOSTIC_LIMIT'); else stderr.push(b); });
  const timer = setTimeout(() => stop('PROCESS_TIMEOUT'), limits.processTimeoutMs);
  try {
    const code = await new Promise<number | null>(resolve => {
      child.once('error', () => { failure ??= new MediaError('PROCESS_START_FAILED'); });
      child.once('close', resolve);
    });
    if(cancelled)throw new MediaError('PROCESS_CANCELLED');
    if (failure) throw failure;
    if (code !== 0) throw new MediaError('MEDIA_PROCESS_FAILED');
    if (errBytes) {
      const expected = toleratedDiagnostics[diagnosticPolicy];
      const lines = Buffer.concat(stderr).toString().trim().split('\n');
      if (!expected || !lines.every(line => expected.test(line))) throw new MediaError('DECODE_DIAGNOSTIC');
    }
    return Buffer.concat(stdout);
  } finally { clearTimeout(timer); activeChildren.delete(child); }
}
export const ffBase = ['-hide_banner', '-nostdin', '-v', 'warning', '-xerror', '-max_alloc', '134217728', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1'];
export const probeBase = ['-v', 'warning', '-max_alloc', '134217728', '-threads', '1'];
