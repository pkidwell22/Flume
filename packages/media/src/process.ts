import { spawn } from 'node:child_process';
import { MediaError } from './types.ts';
import type { Limits } from './types.ts';

// Internal only: public operations select typed profiles, never caller argv/filtergraphs.
export async function run(executable: string, args: readonly string[], limits: Limits, cwd: string, diagnosticPolicy: 'strict' | 'full-range-jpeg-conversion' = 'strict'): Promise<Buffer> {
  const child = spawn(executable, [...args], {
    shell: false, cwd, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TMPDIR: cwd },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    if (failure) throw failure;
    if (code !== 0) throw new MediaError('MEDIA_PROCESS_FAILED');
    if (errBytes) {
      // FFmpeg 9 emits this API-deprecation notice even when JPEG full range is explicitly set.
      // Only conversion passes after a separate strict native decode may accept this exact line.
      const expected = /^\[swscaler @ 0x[0-9a-f]+\] deprecated pixel format used, make sure you did set range correctly$/;
      const lines = Buffer.concat(stderr).toString().trim().split('\n');
      if (diagnosticPolicy !== 'full-range-jpeg-conversion' || !lines.every(line => expected.test(line))) throw new MediaError('DECODE_DIAGNOSTIC');
    }
    return Buffer.concat(stdout);
  } finally { clearTimeout(timer); }
}
export const ffBase = ['-hide_banner', '-nostdin', '-v', 'warning', '-xerror', '-max_alloc', '134217728', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1'];
export const probeBase = ['-v', 'warning', '-max_alloc', '134217728', '-threads', '1'];
