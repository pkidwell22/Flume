import { basename, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FFMPEG, FFPROBE, OUTPUT, generateFixtures } from '../fixtures.ts';

// Fault-inject only fixture-generation I/O; actual media tests remain unmocked.
const { spawn, write } = vi.hoisted(() => ({ spawn: vi.fn(), write: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: spawn }));
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(), readFileSync: () => Buffer.alloc(256), writeFileSync: write,
}));

beforeEach(() => {
  vi.clearAllMocks();
  spawn.mockImplementation((executable: string) => ({
    status: 0, signal: null, stderr: '',
    stdout: `${basename(executable)} version 9.0.1 test-build\nconfiguration: test\n`,
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const manifestPath = resolve(OUTPUT, 'fixtures', 'manifest.json');

test('bounds both version probes and records their first version lines', () => {
  generateFixtures();
  expect(spawn.mock.calls.filter(([, args]) => args[0] === '-version')).toEqual(
    [FFMPEG, FFPROBE].map(executable => [executable, ['-version'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 8_000_000,
    }]),
  );
  const manifest = JSON.parse(write.mock.calls.find(([path]) => path === manifestPath)![1]);
  expect(manifest.tools).toEqual([FFMPEG, FFPROBE].map(executable => ({
    executable, version: `${basename(executable)} version 9.0.1 test-build`,
  })));
});

test.each([
  ['nonzero exit', { status: 1, stderr: 'probe failed' }],
  ['timeout', { status: null, signal: 'SIGTERM', error: new Error('ETIMEDOUT') }],
  ['output overflow even with zero status', { error: new Error('ENOBUFS') }],
  ['spawn failure', { status: null, stdout: null, error: new Error('ENOENT') }],
  ['empty output', { stdout: '' }],
  ['whitespace output', { stdout: ' \t\r\n' }],
  ['wrong tool banner', { stdout: 'other-tool version 9.0.1\n' }],
  ['missing version token', { stdout: 'ffmpeg version \n' }],
])('rejects %s without publishing a manifest', (_label, failure) => {
  const success = spawn.getMockImplementation()!;
  for (const executable of [FFMPEG, FFPROBE]) {
    write.mockClear();
    spawn.mockImplementation((file: string, args: string[]) => ({
      ...success(file),
      ...(file === executable && args[0] === '-version' ? failure : {}),
    }));
    expect(() => generateFixtures()).toThrow(`fixture version probe failed (${executable})`);
    expect(write.mock.calls.some(([path]) => path === manifestPath)).toBe(false);
  }
});
