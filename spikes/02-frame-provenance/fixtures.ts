// Owned synthetic corpus only: fixed pixels, fixed PTS, no downloaded media.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ROOT = fileURLToPath(new URL('.', import.meta.url));
export const OUTPUT = resolve(ROOT, 'output');
export const FFMPEG = '/opt/homebrew/bin/ffmpeg';
export const FFPROBE = '/opt/homebrew/bin/ffprobe';
export const WIDTH = 192;
export const HEIGHT = 108;
export const FIXTURE_IDS = ['cfr', 'vfr', 'equal-pts', 'truncated', 'audio-only', 'multi-video', 'unknown-pts'] as const;
export type FixtureId = typeof FIXTURE_IDS[number];
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const fixturePath = (id: FixtureId) => resolve(OUTPUT, 'fixtures', `${id}.${id === 'unknown-pts' ? 'h264' : 'mkv'}`);

// Independent pixel oracle: saturated frame colors, an ordinal-sized white bar,
// a black top-left patch, and six binary boxes. No extractor code is used here.
export function pixels(index: number): Buffer {
  const colors = [[220, 30, 30], [20, 200, 50], [30, 60, 225], [225, 200, 20], [210, 30, 200], [15, 200, 220]];
  const bytes = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    let color = colors[index];
    if (y < 12) color = x < 12 ? [0, 0, 0] : color;
    if (y >= 25 && y < 50 && x < (index + 1) * 28) color = [255, 255, 255];
    if (y >= 72 && y < 96) color = ((index + 1) >> Math.floor(x / 32)) & 1 ? [255, 255, 255] : [0, 0, 0];
    bytes.set(color, (y * WIDTH + x) * 3);
  }
  return bytes;
}

export function generateFixtures(): void {
  const dir = resolve(OUTPUT, 'fixtures');
  mkdirSync(dir, { recursive: true });
  const commands: unknown[] = [];
  function ff(args: string[]) {
    const full = ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args];
    const result = spawnSync(FFMPEG, full, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8_000_000 });
    commands.push({ executable: FFMPEG, args: full, status: result.status, stderr: result.stderr });
    if (result.status !== 0) throw new Error(`fixture generation failed: ${result.stderr}`);
  }
  for (let n = 0; n < 6; n++) {
    writeFileSync(resolve(dir, `pattern-${n}.ppm`), Buffer.concat([Buffer.from(`P6\n${WIDTH} ${HEIGHT}\n255\n`), pixels(n)]));
  }
  const encode = (name: FixtureId, expr: string) => ff([
    '-framerate', '25', '-i', resolve(dir, 'pattern-%d.ppm'),
    '-vf', `settb=1/1000,setpts=${expr}`, '-frames:v', '6',
    '-fps_mode', 'passthrough', '-enc_time_base', '1/1000', '-c:v', 'ffv1',
    '-level', '3', '-g', '1', '-threads', '1', '-pix_fmt', 'bgr0',
    '-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1', fixturePath(name),
  ]);
  encode('cfr', 'N*40');
  encode('vfr', '5000+if(eq(N\\,0)\\,0\\,if(eq(N\\,1)\\,40\\,if(eq(N\\,2)\\,160\\,if(eq(N\\,3)\\,200\\,if(eq(N\\,4)\\,400\\,480)))))');
  encode('equal-pts', 'if(eq(N\\,2)\\,40\\,N*40)');
  const good = readFileSync(fixturePath('vfr'));
  writeFileSync(fixturePath('truncated'), good.subarray(0, good.length - 200));
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.25', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', fixturePath('audio-only')]);
  ff(['-i', fixturePath('cfr'), '-i', fixturePath('vfr'), '-map', '0:v', '-map', '1:v', '-c', 'copy', '-fflags', '+bitexact', fixturePath('multi-video')]);
  ff(['-framerate', '25', '-i', resolve(dir, 'pattern-%d.ppm'), '-frames:v', '6', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-f', 'h264', fixturePath('unknown-pts')]);
  const manifest = {
    recipe: 'owned-pattern-v1', ownership: 'generated entirely in this experiment; not a provider result',
    width: WIDTH, height: HEIGHT,
    expected: {
      cfr: { timeBase: '1/1000', pts: [0, 40, 80, 120, 160, 200], range: ['0', '0.24'] },
      vfr: { timeBase: '1/1000', pts: [5000, 5040, 5160, 5200, 5400, 5480], range: ['5', '5.52'] },
    },
    rgbSha256: Array.from({ length: 6 }, (_, i) => sha256(pixels(i))),
    files: FIXTURE_IDS.map(id => ({ id, path: fixturePath(id), sha256: sha256(readFileSync(fixturePath(id))) })),
    tools: [FFMPEG, FFPROBE].map(executable => ({ executable, version: spawnSync(executable, ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0] })),
    commands,
  };
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ fixtureManifest: resolve(dir, 'manifest.json'), fixtures: manifest.files }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateFixtures();
