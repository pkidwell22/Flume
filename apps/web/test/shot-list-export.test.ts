// The saved shot list is a planning document. These tests hold it to that
// claim: saved values only, explicit fields only, no network and no command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHOT_LIST_FORMAT,
  buildShotList,
  shotListFile,
  shotListFilenames,
  shotListJson,
  shotListMarkdown,
  saveShotList,
} from '../src/shot-list-export.ts';
import type { ShotListSaveEnvironment } from '../src/shot-list-export.ts';
import type { Asset, Project, Shot } from '../src/types.ts';

const PROJECT: Project = { id: 'p-1', name: 'Ridge line', brief: 'A short film about a ridge at dawn.', revision: 7 };
const controls = (over: Partial<Shot['controls']> = {}): Shot['controls'] => ({ modelId: 'acme/video-1', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false, ...over });
function shot(over: Partial<Shot> = {}): Shot {
  return { id: 's-1', projectId: PROJECT.id, title: 'The opening', prompt: 'A ridge at dawn', revision: 3, selectionRevision: 0, selectedTakeId: null, controls: controls(), bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, ...over };
}
function asset(id: string, projectId: string, filename: string): Asset {
  return { id, projectId, filename, kind: 'image', origin: 'imported', sha256: 'a'.repeat(64), mediaUrl: `/api/media/${id}`, width: 1920, height: 1080 };
}

const RIDGE = asset('a-1', PROJECT.id, 'ridge.png');
const OTHER_ASSET = asset('a-2', 'p-2', 'other-project.png');
const SHOTS: Shot[] = [
  shot({ id: 's-1', title: 'The opening', prompt: 'A ridge at dawn', revision: 3, bindings: { firstFrameAssetId: RIDGE.id, lastFrameAssetId: null } }),
  shot({ id: 's-2', title: 'The climb', prompt: 'A ridge at dawn\nand a slow push in.', revision: 5, controls: controls({ durationSeconds: 8, modelId: 'acme/video-2', resolution: '1080p', aspectRatio: '2.39:1' }) }),
  shot({ id: 's-3', title: 'The summit', prompt: '雪原 — café ☃ 5 → 6', revision: 1, selectedTakeId: 't-1' }),
];
const ASSETS = [RIDGE, OTHER_ASSET, asset('a-3', 'p-2', 'unrelated.png')];
const input = { project: PROJECT, shots: SHOTS, assets: ASSETS };

const tick = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });
/** A DOM + Blob-URL stub: records what a download would touch, touches nothing. */
function fakeEnvironment() {
  const created: Array<{ url: string; blob: Blob }> = [];
  const revoked: string[] = [];
  const clicks: Array<{ href: string; download: string; rel: string; removed: boolean }> = [];
  let sequence = 0;
  const anchors: Array<{ href: string; download: string; rel: string; removed: boolean }> = [];
  const document = {
    createElement: () => {
      const anchor = {
        href: '', download: '', rel: '', removed: false,
        click() { clicks.push({ href: anchor.href, download: anchor.download, rel: anchor.rel, removed: anchor.removed }); },
        remove() { anchor.removed = true; },
      };
      anchors.push(anchor);
      return anchor as unknown as HTMLAnchorElement;
    },
    body: { append: () => {} },
  };
  const env: ShotListSaveEnvironment = {
    createObjectURL: blob => { const url = `blob:fixture/${++sequence}`; created.push({ url, blob }); return url; },
    revokeObjectURL: url => { revoked.push(url); },
    document: document as unknown as Document,
  };
  return { env, created, revoked, clicks, anchors };
}

test('the saved JSON document is a versioned allowlist of saved shot values in reel order', () => {
  assert.equal(SHOT_LIST_FORMAT, 'flume-shot-list/v1');
  const document = buildShotList(input);
  assert.deepEqual(Object.keys(document), ['format', 'project', 'shots']);
  assert.equal(document.format, SHOT_LIST_FORMAT);
  assert.deepEqual(Object.keys(document.project), ['id', 'name', 'brief', 'revision']);
  assert.equal(document.project.brief, PROJECT.brief);
  assert.deepEqual(document.shots.map(item => item.order), [1, 2, 3]);
  assert.deepEqual(document.shots.map(item => item.id), ['s-1', 's-2', 's-3']);
  assert.deepEqual(Object.keys(document.shots[0]!).sort(), ['aspectRatio', 'direction', 'durationSeconds', 'id', 'modelId', 'order', 'references', 'resolution', 'revision', 'title']);
  assert.deepEqual(Object.keys(document.shots[0]!.references).sort(), ['end', 'start']);
  assert.deepEqual(Object.keys(document.shots[0]!.references.start!).sort(), ['assetId', 'filename', 'status']);
  assert.deepEqual(document.shots[0]!.references.start, { assetId: RIDGE.id, filename: 'ridge.png', status: 'saved-in-project' });
  assert.equal(document.shots[0]!.references.end, null);
  assert.equal(document.shots[1]!.durationSeconds, 8);
  assert.equal(document.shots[1]!.modelId, 'acme/video-2');
  assert.equal(document.shots[1]!.aspectRatio, '2.39:1');
  assert.equal(document.shots[2]!.direction, '雪原 — café ☃ 5 → 6');
  const json = shotListJson(document);
  assert.deepEqual(JSON.parse(json), document, 'the file body is exactly the allowlisted document');
  for (const forbidden of ['mediaUrl', 'sha256', 'http://', 'https://', '/api/', 'selectedTakeId', 'selectionRevision', 'generateAudio', 'takes', 'exports', 'attempts', 'reviews', 'capabilities', 'providerJobId', 'estimatedCostUsd', 'origins', 'briefJson']) {
    assert.equal(json.includes(forbidden), false, `the JSON document never carries ${forbidden}`);
  }
});

test('the Markdown keeps the brief, every saved direction and revision in reel order', () => {
  const markdown = shotListMarkdown(buildShotList(input));
  assert.match(markdown, /^# Shot list · Ridge line$/m);
  assert.ok(markdown.includes(PROJECT.brief), 'the saved brief is retained');
  const briefAt = markdown.indexOf(PROJECT.brief);
  const firstAt = markdown.indexOf('The opening');
  const secondAt = markdown.indexOf('The climb');
  const thirdAt = markdown.indexOf('The summit');
  assert.ok(briefAt >= 0 && briefAt < firstAt, 'the brief comes first');
  assert.ok(firstAt < secondAt && secondAt < thirdAt, 'shots stay in reel order');
  assert.ok(markdown.indexOf('A ridge at dawn\nand a slow push in.') >= 0, 'a multiline direction is kept verbatim, line breaks included');
  assert.ok(markdown.includes('雪原 — café ☃ 5 → 6'), 'Unicode survives unchanged');
  for (const revision of ['**Revision:** 3', '**Revision:** 5', '**Revision:** 1']) assert.ok(markdown.includes(revision), revision);
  assert.equal((markdown.match(/\*\*Revision:\*\*/g) ?? []).length, 3, 'every saved shot appears exactly once');
  assert.match(markdown, /planning document/i);
  assert.match(markdown, /not rendered video/i);
  assert.match(markdown, /not a generation receipt/i);
  assert.match(markdown, /Unsaved edits are not included/);
  assert.match(markdown, /not proof of the current files, rights/i);
  assert.ok(markdown.endsWith('\n'), 'the file ends with one newline');
});

test('cross-project and missing references are named honestly and never borrow metadata', () => {
  const document = buildShotList({
    project: PROJECT,
    shots: [shot({ bindings: { firstFrameAssetId: OTHER_ASSET.id, lastFrameAssetId: 'missing-asset' } })],
    assets: [OTHER_ASSET, ...ASSETS],
  });
  const references = document.shots[0]!.references;
  assert.deepEqual(references.start, { assetId: OTHER_ASSET.id, filename: null, status: 'not-in-project' });
  assert.deepEqual(references.end, { assetId: 'missing-asset', filename: null, status: 'not-in-project' });
  const json = shotListJson(document);
  assert.equal(json.includes('other-project.png'), false, 'another project’s filename never enters the document');
  assert.equal(json.includes('unrelated.png'), false);
  const markdown = shotListMarkdown(document);
  assert.equal(markdown.includes('other-project.png'), false);
  assert.match(markdown, /Not in this project/);
  assert.doesNotMatch(markdown, /null|undefined/);
  // An absent binding says so instead of inventing a reference.
  const empty = buildShotList({ project: PROJECT, shots: [shot()], assets: ASSETS });
  assert.equal(empty.shots[0]!.references.start, null);
  assert.match(shotListMarkdown(empty), /None saved/);
});

test('hostile Markdown and HTML in saved text stays text', () => {
  const hostile = {
    project: { ...PROJECT, name: 'Ridge <img src=x onerror=alert(1)>', brief: 'Brief\n## Injected heading\n[link](https://evil.invalid)' },
    shots: [
      shot({
        title: 'The opening\n## Injected title',
        prompt: [
          '<script>alert("x")</script>',
          '```',
          '## breakout',
          '---',
          '| a | b |',
          '> quote',
          '1. ordered',
          '- bullet',
          '===',
          '    indented code',
          '&amp; &lt;',
          'He said "cut" — \'again\'',
        ].join('\n'),
      }),
    ],
    assets: ASSETS,
  };
  const markdown = shotListMarkdown(buildShotList(hostile));
  assert.equal(markdown.includes('<'), false, 'no raw angle brackets survive');
  assert.equal(markdown.includes('```'), false, 'fences cannot break out');
  assert.equal(markdown.includes('[link]('), false, 'links cannot be injected');
  assert.equal(markdown.includes('&amp;amp;'), true, 'pre-escaped entities are escaped again, not resolved');
  const lines = markdown.split('\n');
  for (const line of lines) {
    assert.doesNotMatch(line, /^#{3,}/, `no injected heading level: ${line}`);
    assert.doesNotMatch(line, /^\s*>/, `no injected blockquote: ${line}`);
    assert.doesNotMatch(line, /^\s*\|/, `no injected table row: ${line}`);
    assert.doesNotMatch(line, /^\s*\d+[.)]\s/, `no injected ordered list: ${line}`);
    assert.doesNotMatch(line, /^\s*=+\s*$/, `no injected setext underline: ${line}`);
    assert.notEqual(line, '---', 'no injected thematic break');
    assert.equal(/^ {4}|^\t/.test(line), false, 'no injected indented code block');
  }
  // The only bullets in the document are its own metadata lines; no saved text opens one.
  for (const line of lines.filter(item => item.startsWith('- '))) {
    assert.match(line, /^- \*\*(Project|Saved shots|Document format|Shot ID|Revision|Duration|Model|Aspect ratio|Resolution|Start frame|End frame):\*\* /, `unexpected bullet: ${line}`);
  }
  assert.equal(lines.includes('## Injected title'), false, 'a newline in a title cannot start a section');
  assert.equal(lines.includes('## Injected heading'), false, 'a newline in the brief cannot start a section');
  assert.ok(markdown.includes('&lt;script&gt;'), 'hostile HTML is escaped, not dropped');
  assert.ok(markdown.includes('He said "cut" — \'again\''), 'quotes are preserved literally');
  assert.ok(markdown.includes('alert(1)'), 'no saved text is silently truncated');
});

test('filenames are deterministic, path-free and readable', () => {
  const names = shotListFilenames(PROJECT);
  assert.deepEqual(names, { markdown: 'ridge-line-shot-list.md', json: 'ridge-line-shot-list.json' });
  assert.deepEqual(shotListFilenames(PROJECT), names, 'the same project always yields the same name');
  for (const kind of ['markdown', 'json'] as const) {
    const file = shotListFile(input, kind);
    assert.equal(file.filename, names[kind]);
    assert.match(file.filename, /^[a-z0-9][a-z0-9-]*-shot-list\.(md|json)$/);
    assert.equal(file.filename.includes('/'), false);
    assert.equal(file.filename.includes('..'), false);
  }
  const hostile = shotListFilenames({ ...PROJECT, name: '../../etc/Pass: "List" <script>\u0000 — 雪' });
  assert.equal(hostile.markdown.includes('/'), false);
  assert.equal(hostile.markdown.includes('..'), false);
  assert.equal(/[\u0000-\u001f<>:"|?*]/.test(hostile.markdown), false, 'no control or path characters');
  assert.ok(hostile.markdown.endsWith('-shot-list.md'));
  assert.ok(hostile.markdown.length <= 72, 'the name stays a reasonable length');
  assert.equal(shotListFilenames({ ...PROJECT, name: '雪 — ☃' }).markdown, 'flume-project-shot-list.md', 'an unnameable project falls back to a safe label');
});

test('a complete document needs no takes, exports or provider configuration', () => {
  const document = buildShotList({ project: PROJECT, shots: SHOTS, assets: ASSETS });
  assert.equal(document.shots.length, 3);
  const json = shotListJson(document);
  assert.equal(json.includes('"takes"'), false);
  assert.equal(json.includes('"exports"'), false);
  assert.equal(json.includes('"capabilities"'), false);
  assert.equal(json.includes('provider'), false);
  const markdown = shotListMarkdown(document);
  assert.ok(markdown.includes('The climb') && markdown.includes('The summit'));
  assert.equal(markdown.includes('No selected take'), false, 'the planning document makes no export claim');
});

test('a download writes one blob through one anchor and releases the object URL', async () => {
  const fake = fakeEnvironment();
  const file = shotListFile(input, 'markdown');
  const result = saveShotList(file, fake.env);
  assert.equal(result.ok, true);
  assert.equal(result.filename, file.filename);
  assert.match(result.message, /download/i);
  assert.doesNotMatch(result.message, /saved|written to|check your downloads folder/i, 'a click is never reported as a completed save');
  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0]!.blob.type, file.mime);
  assert.equal(await fake.created[0]!.blob.text(), file.body);
  assert.equal(fake.clicks.length, 1, 'exactly one anchor is clicked');
  assert.equal(fake.clicks[0]!.href, fake.created[0]!.url);
  assert.equal(fake.clicks[0]!.download, file.filename);
  assert.equal(fake.clicks[0]!.rel, 'noopener');
  assert.equal(fake.anchors[0]!.removed, true, 'the anchor is removed from the document');
  await tick();
  assert.deepEqual(fake.revoked, [fake.created[0]!.url], 'the object URL is released');
});

test('repeated downloads produce identical bytes and never reuse an object URL', async () => {
  const fake = fakeEnvironment();
  const first = shotListFile(input, 'json');
  const second = shotListFile(input, 'json');
  assert.equal(first.body, second.body, 'the same saved state produces the same file');
  assert.equal(saveShotList(first, fake.env).ok, true);
  assert.equal(saveShotList(second, fake.env).ok, true);
  await tick();
  assert.equal(fake.created.length, 2);
  assert.notEqual(fake.created[0]!.url, fake.created[1]!.url);
  assert.deepEqual(fake.revoked, fake.created.map(item => item.url), 'both URLs are released, nothing leaks');
  assert.equal(fake.clicks.length, 2);
  assert.deepEqual(await Promise.all(fake.created.map(item => item.blob.text())), [first.body, second.body]);
});

test('unsupported browsers and failed clicks report an honest failure instead of a save', () => {
  const file = shotListFile(input, 'json');
  const unsupported = saveShotList(file, { createObjectURL: null, revokeObjectURL: null, document: null });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.message, /not saved/);
  assert.match(unsupported.message, new RegExp(file.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const fake = fakeEnvironment();
  const brokenDocument = { createElement: () => { throw new Error('the browser refused the download'); }, body: { append: () => {} } };
  const broken = saveShotList(file, { ...fake.env, document: brokenDocument as unknown as Document });
  assert.equal(broken.ok, false);
  assert.match(broken.message, /not saved/);
  const noDocument = saveShotList(file, { createObjectURL: fake.env.createObjectURL, revokeObjectURL: fake.env.revokeObjectURL, document: null });
  assert.equal(noDocument.ok, false);
  assert.match(noDocument.message, /not saved/);
  assert.equal(fake.clicks.length, 0);
});

test('a shot row from another project never enters either document, and orders stay contiguous', () => {
  const foreign = shot({ id: 's-9', projectId: 'p-2', title: 'A shot from elsewhere', prompt: 'Direction from elsewhere.\n- and a foreign bullet', revision: 4 });
  const document = buildShotList({ project: PROJECT, shots: [SHOTS[0]!, foreign, SHOTS[1]!, SHOTS[2]!], assets: ASSETS });
  assert.deepEqual(document.shots.map(item => item.id), ['s-1', 's-2', 's-3'], 'the foreign shot row is filtered out');
  assert.deepEqual(document.shots.map(item => item.order), [1, 2, 3], 'the reel renumbers contiguously');
  const json = shotListJson(document);
  assert.equal(json.includes('s-9'), false);
  assert.equal(json.includes('A shot from elsewhere'), false);
  assert.equal(json.includes('Direction from elsewhere'), false);
  const markdown = shotListMarkdown(document);
  assert.equal(markdown.includes('A shot from elsewhere'), false);
  assert.equal(markdown.includes('Direction from elsewhere'), false);
  assert.equal((markdown.match(/\*\*Revision:\*\*/g) ?? []).length, 3, 'only the three in-project shots are documented');
});

test('LF, CRLF and bare CR are all Markdown line boundaries, and the JSON keeps the saved bytes', () => {
  const direction = 'intro\r- injected bullet\r1. injected ordered\r    injected code';
  const brief = 'First paragraph\r\n## Injected heading\r\nlast line';
  const title = 'The opening\r## Injected title';
  const crlfDirection = '雪原\r\n— café ☃\r5 → 6';
  const document = buildShotList({
    project: { ...PROJECT, name: title, brief },
    shots: [
      shot({ title, prompt: direction }),
      shot({ id: 's-crlf', prompt: crlfDirection }),
      shot({ id: 's-trailing', prompt: 'tail line\r' }),
    ],
    assets: ASSETS,
  });

  // The JSON document is the saved record: every line ending stays exactly as saved.
  assert.equal(document.project.brief, brief);
  assert.equal(document.shots[0]!.direction, direction);
  assert.equal(document.shots[1]!.direction, crlfDirection);
  assert.equal(document.shots[2]!.direction, 'tail line\r');
  const json = shotListJson(document);
  assert.ok(json.includes('intro\\r- injected bullet'), 'the saved CR survives in JSON as an escape');
  assert.ok(json.includes('First paragraph\\r\\n## Injected heading'), 'the saved CRLF survives in JSON as an escape');

  // The Markdown treats all three boundaries the same, so every line start is escaped.
  const markdown = shotListMarkdown(document);
  assert.equal(markdown.includes('\r'), false, 'no raw CR or CRLF survives into the Markdown');
  const lines = markdown.split('\n');
  assert.ok(lines.includes('\\- injected bullet'), 'a bare-CR bullet is escaped at its line start');
  assert.ok(lines.includes('1\\. injected ordered'), 'a bare-CR ordered item is escaped at its line start');
  assert.ok(lines.includes('&#32;&#32;&#32;&#32;injected code'), 'bare-CR code indentation cannot open a code block');
  assert.equal(lines.includes('- injected bullet'), false, 'no unescaped bare-CR bullet');
  assert.equal(lines.includes('1. injected ordered'), false, 'no unescaped bare-CR ordered item');
  assert.equal(lines.includes('    injected code'), false, 'no unescaped bare-CR code indentation');
  assert.ok(lines.includes('First paragraph') && lines.includes('last line'), 'CRLF lines are kept, not dropped');
  assert.ok(lines.includes('\\#\\# Injected heading'), 'a CRLF heading line is escaped, not opened');
  assert.equal(lines.includes('## Injected heading'), false, 'a CRLF heading in the brief cannot open a section');
  assert.ok(lines.includes('雪原') && lines.includes('— café ☃') && lines.includes('5 → 6'), 'Unicode CRLF lines survive whole');
  assert.ok(lines.includes('tail line'), 'a CR at a field boundary does not truncate the line');
  assert.equal(lines.includes('## Injected title'), false, 'a CR in a title cannot open a section');
  assert.ok(markdown.includes('The opening \\#\\# Injected title'), 'a title keeps its words on one line');
  for (const line of lines) {
    assert.doesNotMatch(line, /^\d{1,9}[.)]\s/, `no bare-CR ordered item: ${line}`);
    assert.doesNotMatch(line, /^#{3,}/, `no bare-CR heading: ${line}`);
    assert.equal(/^ {4}|^\t/.test(line), false, `no bare-CR indented code block: ${line}`);
  }
});

test('a binding that is neither a saved id nor an explicit absence refuses to build the document', () => {
  const malformed = {
    project: PROJECT,
    shots: [shot({ bindings: { firstFrameAssetId: undefined as unknown as string, lastFrameAssetId: null } })],
    assets: ASSETS,
  };
  assert.throws(() => buildShotList(malformed), 'an absent id is not a saved reference and is not invented');
  assert.throws(() => shotListFile(malformed, 'json'));
  assert.throws(() => shotListFile(malformed, 'markdown'));
});

test('each format carries an explicit MIME type and a parseable body', () => {
  const markdown = shotListFile(input, 'markdown');
  const json = shotListFile(input, 'json');
  assert.equal(markdown.mime, 'text/markdown;charset=utf-8');
  assert.equal(json.mime, 'application/json;charset=utf-8');
  assert.equal(markdown.label, 'Markdown');
  assert.equal(json.label, 'JSON');
  assert.doesNotThrow(() => JSON.parse(json.body));
  assert.ok(markdown.body.startsWith('# Shot list'), 'the Markdown body starts with the document heading');
});
