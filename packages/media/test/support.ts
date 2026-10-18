import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

export const FFMPEG = process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH ?? '/opt/homebrew/bin/ffprobe';
export const projectId = '10000000-0000-4000-8000-000000000001';
export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const id = randomUUID;
export const WIDTH = 64, HEIGHT = 48;
export const pts = ['5000', '5040', '5160', '5200', '5400', '5480'];
export function pixels(n: number) {
  const b = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let p = 0; p < WIDTH * HEIGHT; p++) b.set([(n * 31 + p) % 256, (n * 53 + p % WIDTH) % 256, (n * 79 + Math.floor(p / WIDTH)) % 256], p * 3);
  return b;
}
export function ff(args: string[]) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-threads', '1', '-filter_threads', '1', ...args], { timeout: 15_000, maxBuffer: 4_000_000 });
  assert.equal(r.status, 0, r.stderr?.toString());
  assert.ifError(r.error);
  return r.stdout;
}
export async function fixture(t: TestContext) {
  assert.ok(process.env.TMPDIR, 'explicit isolated TMPDIR required');
  const parent = await realpath(process.env.TMPDIR!);
  const dir = await mkdtemp(join(parent, 'flume-media-test-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const inputs = join(dir, 'inputs'); await mkdir(inputs);
  for (let n = 0; n < 6; n++) await writeFile(join(inputs, `frame-${n}.ppm`), Buffer.concat([Buffer.from(`P6\n${WIDTH} ${HEIGHT}\n255\n`), pixels(n)]));
  const video = join(inputs, 'source.mkv');
  ff(['-framerate', '25', '-i', join(inputs, 'frame-%d.ppm'), '-vf', 'settb=1/1000,setpts=5000+if(eq(N\\,0)\\,0\\,if(eq(N\\,1)\\,40\\,if(eq(N\\,2)\\,160\\,if(eq(N\\,3)\\,200\\,if(eq(N\\,4)\\,400\\,480)))))', '-frames:v', '6', '-fps_mode', 'passthrough', '-enc_time_base', '1/1000', '-c:v', 'ffv1', '-level', '3', '-threads', '1', '-pix_fmt', 'bgr0', video]);
  const image = join(inputs, 'first.png');
  ff(['-i', join(inputs, 'frame-0.ppm'), '-frames:v', '1', '-threads', '1', '-update', '1', image]);
  return { dir, inputs, video, image, options: { root: join(dir, 'store'), importRoots: [inputs], ffmpegPath: FFMPEG, ffprobePath: FFPROBE } };
}
