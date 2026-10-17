import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WIDTH, HEIGHT, RECIPE, render } from './scene.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const FFMPEG = '/opt/homebrew/bin/ffmpeg', FFPROBE = '/opt/homebrew/bin/ffprobe';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const json = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
const ppm = pixels => Buffer.concat([Buffer.from(`P6\n${WIDTH} ${HEIGHT}\n255\n`), pixels]);
const flags = ['-hide_banner','-nostdin','-v','warning','-xerror'];
const input = path => ['-protocol_whitelist','file,pipe','-i',path];

export function requireCleanProcess(result) {
  if (result.error || result.signal || result.status !== 0) fail('MEDIA_PROCESS_FAILED');
  if (result.stderr.length) fail('MEDIA_PROCESS_DIAGNOSTIC');
  return result.stdout;
}

// Only this owned, fixed fixture is accepted. There is no media-intake API.
export async function build() {
  mkdirSync(join(ROOT, 'output'), { recursive: true });
  const dir = mkdtempSync(join(ROOT, 'output', 'kit-'));
  mkdirSync(join(dir, 'evidence')); mkdirSync(join(dir, 'raw'));
  const commands = [];
  function run(label, executable, args) {
    const result = spawnSync(executable, args, {
      encoding: 'buffer', timeout: 60_000, maxBuffer: 8_000_000, stdio: ['ignore','pipe','pipe'],
    });
    const command = { label, executable, args, exitCode: result.status, signal: result.signal,
      error: result.error?.message ?? null };
    commands.push(command);
    writeFileSync(join(dir, 'evidence', `${label}.stdout`), result.stdout ?? Buffer.alloc(0));
    writeFileSync(join(dir, 'evidence', `${label}.stderr`), result.stderr ?? Buffer.alloc(0));
    json(join(dir, 'evidence', 'commands.json'), commands);
    try {
      return requireCleanProcess(result);
    } catch (error) {
      throw new Error(`${error.message}: ${label}; evidence=${dir}`, { cause: error });
    }
  }
  const versions = {
    node: process.version,
    ffmpeg: run('ffmpeg-version', FFMPEG, ['-version']).toString().split('\n')[0],
    ffprobe: run('ffprobe-version', FFPROBE, ['-version']).toString().split('\n')[0],
  };
  const expected = [];
  for (let i = 0; i < 24; i++) {
    const pixels = render(i); expected.push(sha(pixels));
    writeFileSync(join(dir, 'raw', `${String(i).padStart(3,'0')}.ppm`), ppm(pixels));
  }
  const clip = join(dir, 'prior.mkv');
  run('encode-prior', FFMPEG, [...flags, '-framerate','12', ...input(join(dir,'raw','%03d.ppm')),
    '-map','0:v:0','-frames:v','24','-an','-c:v','ffv1','-level','3','-pix_fmt','bgr0',
    '-threads','1','-fflags','+bitexact','-flags:v','+bitexact','-map_metadata','-1', clip]);
  chmodSync(clip, 0o444);
  const sourceBytes = readFileSync(clip), sourceSha256 = sha(sourceBytes);
  const probe = JSON.parse(run('probe-prior', FFPROBE, ['-v','warning','-protocol_whitelist','file,pipe',
    '-show_streams','-show_frames','-show_format','-of','json',clip]));
  if (probe.streams.length !== 1 || probe.streams[0].codec_type !== 'video') fail('ONE_VIDEO_ONLY');
  const stream = probe.streams[0];
  if (stream.width !== WIDTH || stream.height !== HEIGHT || stream.time_base !== '1/1000') fail('UNEXPECTED_STREAM');
  const decoded = probe.frames;
  if (decoded.length !== 24 || decoded.some((f,i) => f.stream_index !== stream.index ||
    !Number.isSafeInteger(f.pts) || (i > 0 && f.pts <= decoded[i-1].pts))) fail('UNEXPECTED_DECODED_PTS');
  function rows(bytes) {
    const text = bytes.toString();
    if (text.match(/#tb 0: (\S+)/)?.[1] !== stream.time_base) fail('TIMEBASE_MISMATCH');
    return text.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').map(v => v.trim()));
  }
  const hashes = rows(run('decoded-framehash', FFMPEG, [...flags, '-copyts', ...input(clip),
    '-map',`0:${stream.index}`,'-an','-sn','-dn','-fps_mode','passthrough','-enc_time_base','demux',
    '-c:v','rawvideo','-pix_fmt','rgb24','-f','framehash','-hash','sha256','-']));
  if (hashes.length !== decoded.length || hashes.some((row,i) => row[2] !== String(decoded[i].pts) ||
    row[5] !== expected[i])) fail('DECODE_IDENTITY_MISMATCH');
  const frames = decoded.map((frame,i) => ({ index: i, pts: String(frame.pts),
    duration: String(frame.duration), rgbSha256: hashes[i][5] }));
  // Explicit fixture range [0,2000) in the measured 1/1000 source clock.
  const eligible = frames.filter(frame => BigInt(frame.pts) >= 0n && BigInt(frame.pts) < 2000n);
  const chosen = eligible.at(-1);
  if (!chosen) fail('NO_ELIGIBLE_FRAME');
  const extracted = rows(run('final-extraction', FFMPEG, [...flags, '-copyts', ...input(clip),
    '-filter_complex',`[0:${stream.index}]select=eq(n\\,${chosen.index}),split=2[image][hash]`,
    '-map','[image]','-frames:v','1','-fps_mode','passthrough','-c:v','png','-threads','1','-update','1',join(dir,'first-reference.png'),
    '-map','[hash]','-frames:v','1','-fps_mode','passthrough','-enc_time_base',stream.time_base,
    '-c:v','rawvideo','-pix_fmt','rgb24','-f','framehash','-hash','sha256','-']));
  if (extracted.length !== 1 || extracted[0][2] !== chosen.pts || extracted[0][5] !== chosen.rgbSha256) fail('EXTRACTION_MISMATCH');
  run('opening-extraction', FFMPEG, [...flags, ...input(clip), '-map',`0:${stream.index}`,
    '-frames:v','1','-c:v','png','-threads','1','-update','1',join(dir,'prior-opening.png')]);
  function imageIdentity(name) {
    const bytes = readFileSync(join(dir, name));
    if (bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') fail('NOT_PNG');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    const pixels = run(name.replace('.png','')+'-roundtrip', FFMPEG, [...flags, ...input(join(dir,name)),
      '-f','rawvideo','-pix_fmt','rgb24','-']);
    if (width !== WIDTH || height !== HEIGHT || pixels.length !== width*height*3) fail('IMAGE_DIMENSIONS_MISMATCH');
    return { path: name, mime: 'image/png', width, height, bytes: bytes.length,
      sha256: sha(bytes), rgbSha256: sha(pixels) };
  }
  const image = imageIdentity('first-reference.png');
  if (image.rgbSha256 !== chosen.rgbSha256 || sha(readFileSync(clip)) !== sourceSha256) fail('SOURCE_OR_PNG_CHANGED');
  const sceneRevision = sha(readFileSync(join(ROOT,'scene.mjs')));
  writeFileSync(join(dir,'raw','end.ppm'), ppm(render(47)));
  run('render-end-png', FFMPEG, [...flags, ...input(join(dir,'raw','end.ppm')),
    '-frames:v','1','-c:v','png','-threads','1','-update','1',join(dir,'end-reference.png')]);
  const endImage = imageIdentity('end-reference.png');
  const openingImage = imageIdentity('prior-opening.png');
  const panels = [openingImage, image, endImage];
  run('gallery', FFMPEG, [...flags, ...panels.flatMap(p => input(join(dir,p.path))),
    '-filter_complex','[0:v][1:v][2:v]hstack=inputs=3[out]','-map','[out]',
    '-frames:v','1','-c:v','png','-threads','1','-update','1',join(dir,'gallery.png')]);
  const galleryBytes = readFileSync(join(dir,'gallery.png'));
  const manifest = {
    schemaVersion: 1, purpose: 'Preparation for #7; does not close #7', fixtureId: RECIPE.id,
    provenance: { kind: 'owned-synthetic-illustration', statement: RECIPE.provenance,
      photorealismClaim: false, importedMedia: false, providerCall: false, upload: false },
    recipe: RECIPE, revisions: { sceneSha256: sceneRevision, kitSha256: sha(readFileSync(join(ROOT,'kit.mjs'))) },
    tools: versions,
    gallery: { path: 'gallery.png', width: WIDTH*3, height: HEIGHT, bytes: galleryBytes.length,
      sha256: sha(galleryBytes), panels },
    source: { path: 'prior.mkv', takeId: 'owned-red-mug-prior-v1', sha256: sourceSha256, bytes: sourceBytes.length,
      streamIndex: stream.index, codec: stream.codec_name, pixelFormat: stream.pix_fmt,
      width: stream.width, height: stream.height, timeBase: stream.time_base,
      range: { startPts: '0', endPtsExclusive: '2000' }, eof: 'observed-clean-decode', frames },
    bindings: [{ role: 'first_frame', original: image, prepared: { ...image },
      preparation: { operation: 'identity-no-transform', routeAcceptance: 'unverified' },
      provenance: { kind: 'actual-decoded-source-frame', sourceSha256, sourceTakeId: 'owned-red-mug-prior-v1',
        sceneRevision, streamIndex: stream.index, timeBase: stream.time_base, frameIndex: chosen.index,
        pts: chosen.pts, sourceSeconds: `${chosen.pts}/1000`, selection: 'max decoded PTS in [0,2000)',
        rgbSha256: chosen.rgbSha256 } },
      { role: 'last_frame', original: endImage, prepared: { ...endImage },
        preparation: { operation: 'identity-no-transform', routeAcceptance: 'unverified' },
        provenance: { kind: 'same-scene-render', sceneRevision, cameraStep: 47,
          rgbSha256: endImage.rgbSha256 } }],
  };
  json(join(dir,'manifest.json'), manifest);
  const captions = ['Prior clip opening: frame 0, PTS 0 (comparison only)',
    `first_frame: actual prior tail, frame ${chosen.index}, PTS ${chosen.pts} @ ${stream.time_base}`,
    'last_frame: same scene, closer camera step 47 (not extracted from prior)'];
  writeFileSync(join(dir,'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>Owned red-mug fixture</title>
<style>body{font:16px system-ui;margin:32px;background:#f5f3ee;color:#262521}main{display:grid;gap:24px}
figure{margin:0}img{width:100%;max-width:960px;display:block}code{overflow-wrap:anywhere;font-size:12px}
figcaption{margin:8px 0}a{color:#8d2922}</style><h1>Owned red-mug fixture</h1>
<p>Synthetic illustration — not a photograph or provider result. Preparation for #7; does not close #7.</p>
<p>Fixed geometry and lighting; physical perspective-camera translation only. No input crop/resize.</p>
<main>${panels.map((p,i) => `<figure><img src="${p.path}" alt="${captions[i]}">
<figcaption>${captions[i]}<br>${p.width}×${p.height}, ${p.bytes} bytes<br><code>SHA256 ${p.sha256}</code></figcaption></figure>`).join('\n')}</main>
<p><a href="gallery.png">PNG triptych (left → right: opening, first_frame, last_frame)</a> ·
<a href="manifest.json">Measured manifest</a> · <a href="prior.mkv">Lossless prior clip</a></p>
<p>Route size/transport compatibility, uploads, generation, spend and human creative acceptance remain unverified/unapproved.</p></html>\n`);
  return { dir, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('Usage: node kit.mjs (fixed local fixture only; no arguments)');
    process.exitCode = 2;
  } else {
    const { dir } = await build();
    console.log(JSON.stringify({ dir, manifestPath: join(dir,'manifest.json'),
      sourcePath: join(dir,'prior.mkv'), galleryPath: join(dir,'gallery.png') }, null, 2));
  }
}
