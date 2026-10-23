import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { run } from '../src/process.ts';
import { DEFAULT_LIMITS } from '../src/types.ts';

// Exact text emitted by FFmpeg 7 on arm64 when swscale has no accelerated yuv420p->rgb24
// colorspace conversion. Only this one line, on the RGB hash conversion pass, is benign.
const NOTICE = '[swscaler @ 0xffff8c010f80] No accelerated colorspace conversion found from yuv420p to rgb24.';
const JPEG_NOTICE = '[swscaler @ 0x7f8a1c010f80] deprecated pixel format used, make sure you did set range correctly';

async function stub(t: TestContext, lines: readonly string[], exitCode: number) {
  const dir = await mkdtemp(join(await realpath(process.env.TMPDIR!), 'flume-diagnostic-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const exe = join(dir, 'fake-ffmpeg.cjs');
  const payload = lines.map(line => `${line}\n`).join('');
  await writeFile(exe, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(payload)});\nprocess.exit(${exitCode});\n`, { mode: 0o700 });
  await chmod(exe, 0o700);
  return { dir, exe };
}

test('the exact arm64 software RGB fallback notice is tolerated on the RGB conversion pass only', async t => {
  const { dir, exe } = await stub(t, [NOTICE], 0);
  assert.deepEqual([...(await run(exe, [], DEFAULT_LIMITS, dir, 'software-rgb-conversion'))], []);
  // Repeating the same known line is still only that known line.
  const repeated = await stub(t, [NOTICE, NOTICE, NOTICE], 0);
  assert.deepEqual([...(await run(repeated.exe, [], DEFAULT_LIMITS, repeated.dir, 'software-rgb-conversion'))], []);
  // The native decode pass and every other caller stay strict.
  await assert.rejects(run(exe, [], DEFAULT_LIMITS, dir), /DECODE_DIAGNOSTIC/);
  await assert.rejects(run(exe, [], DEFAULT_LIMITS, dir, 'strict'), /DECODE_DIAGNOSTIC/);
  // JPEG full-range conversion keeps its own single tolerance; policies never widen each other.
  await assert.rejects(run(exe, [], DEFAULT_LIMITS, dir, 'full-range-jpeg-conversion'), /DECODE_DIAGNOSTIC/);
});

test('mixed, extended, or unrelated diagnostics still fail the software RGB conversion pass', async t => {
  const mixed = await stub(t, [NOTICE, '[h264 @ 0x7f8a1c030000] Error while decoding stream #0:0: Invalid data found when processing input'], 0);
  await assert.rejects(run(mixed.exe, [], DEFAULT_LIMITS, mixed.dir, 'software-rgb-conversion'), /DECODE_DIAGNOSTIC/);
  const reversed = await stub(t, ['[mov,mp4,m4a,3gp,3g2,mj2 @ 0x7f8a1c020000] Packet corrupt (stream = 0, dts = -2048).', NOTICE], 0);
  await assert.rejects(run(reversed.exe, [], DEFAULT_LIMITS, reversed.dir, 'software-rgb-conversion'), /DECODE_DIAGNOSTIC/);
  for (const line of [
    '[swscaler @ 0xffff8c010f80] No accelerated colorspace conversion found from yuv420p to bgr24.',
    '[swscaler @ 0xffff8c010f80] No accelerated colorspace conversion found from yuvj420p to rgb24.',
    '[swscaler @ 0xffff8c010f80] No accelerated colorspace conversion found from yuv420p10le to rgb24.',
    `${NOTICE} (frame 2)`,
    NOTICE.replace('No accelerated', 'no accelerated'),
    `[swscaler @ 0xffff8c010f80] No accelerated colorspace conversion found from yuv420p to rgb24`,
  ]) {
    const near = await stub(t, [line], 0);
    await assert.rejects(run(near.exe, [], DEFAULT_LIMITS, near.dir, 'software-rgb-conversion'), /DECODE_DIAGNOSTIC/, line);
  }
});

test('a nonzero exit is still a failed decode even when the tolerated notice is the only diagnostic', async t => {
  const { dir, exe } = await stub(t, [NOTICE], 1);
  await assert.rejects(run(exe, [], DEFAULT_LIMITS, dir, 'software-rgb-conversion'), /MEDIA_PROCESS_FAILED/);
});

test('JPEG full-range conversion tolerance is unchanged by the software RGB policy', async t => {
  const { dir, exe } = await stub(t, [JPEG_NOTICE], 0);
  assert.deepEqual([...(await run(exe, [], DEFAULT_LIMITS, dir, 'full-range-jpeg-conversion'))], []);
  await assert.rejects(run(exe, [], DEFAULT_LIMITS, dir), /DECODE_DIAGNOSTIC/);
  await assert.rejects(run(exe, [], DEFAULT_LIMITS, dir, 'software-rgb-conversion'), /DECODE_DIAGNOSTIC/);
  const both = await stub(t, [JPEG_NOTICE, NOTICE], 0);
  await assert.rejects(run(both.exe, [], DEFAULT_LIMITS, both.dir, 'full-range-jpeg-conversion'), /DECODE_DIAGNOSTIC/);
});
