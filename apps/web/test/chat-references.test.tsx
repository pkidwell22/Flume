import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<body></body>', { url: 'http://127.0.0.1:4310' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  File: dom.window.File,
  FormData: dom.window.FormData,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { fireEvent } = await import('@testing-library/react');
const { ChatPanel, createHttpChatPort } = await import('../src/ChatPanel.tsx');
after(() => dom.window.close());

const projectId = '10000000-0000-4000-8000-000000000001';
const shot = { id: '10000000-0000-4000-8000-000000000002', title: 'Door', revision: 3 };
const video = { id: '10000000-0000-4000-8000-000000000003', projectId, filename: 'walkthrough.mp4', kind: 'video', origin: 'imported', sha256: 'video-sha', mediaUrl: `/api/media/10000000-0000-4000-8000-000000000003`, width: 1920, height: 1080, durationSeconds: 8 } as const;
const frame = { id: '10000000-0000-4000-8000-000000000004', projectId, filename: 'walkthrough-first.png', kind: 'image', origin: 'imported', sha256: 'frame-sha', mediaUrl: '/api/media/frame', width: 512, height: 288 } as const;
const videoB = { ...video, id: '10000000-0000-4000-8000-000000000005', filename: 'second.mp4', sha256: 'video-b', mediaUrl: '/api/media/10000000-0000-4000-8000-000000000005' } as const;
const frameB = { ...frame, id: '10000000-0000-4000-8000-000000000006', filename: 'second-first.png', sha256: 'frame-b', mediaUrl: '/api/media/10000000-0000-4000-8000-000000000006' } as const;
const reference = { assetId: video.id, sourceSha256: video.sha256, kind: 'video', durationSeconds: 8, totalFrames: 240, sampling: 'uniform-frame-index-v1', frames: [{ index: 0, timestampSeconds: 0, sha256: 'a' }, { index: 239, timestampSeconds: 7.967, sha256: 'b' }], audio: 'not-analyzed' };
const conversation = { id: '10000000-0000-4000-8000-000000000010', projectId, title: 'Scene', modelId: 'ollama/kimi-k3', messages: [{ id: '10000000-0000-4000-8000-000000000011', role: 'assistant', status: 'completed', content: 'The subject crosses frame.', usage: null, recordedContext: { references: [reference] } }] };

function button(name: string) { return [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name) as HTMLButtonElement | undefined; }
async function mount(port: any, props: Record<string, unknown> = {}) {
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  const base = { project: { id: projectId, name: 'Film' }, shot, assets: [video], ...props } as any;
  await React.act(async () => root.render(<ChatPanel port={port} dirty={false} {...base} />));
  await React.act(async () => {});
  return { element, async render(nextPort: any, nextProps: Record<string, unknown> = {}) { await React.act(async () => root.render(<ChatPanel port={nextPort} dirty={false} {...base} {...nextProps} />)); await React.act(async () => {}); }, async close() { await React.act(async () => root.unmount()); element.remove(); } };
}

test('HTTP reference methods upload multipart and extract only a bounded frame selector', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(calls.length === 1 ? video : frame), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const port = createHttpChatPort(fetcher as typeof fetch);
  const file = new File(['video'], 'walkthrough.mp4', { type: 'video/mp4' });
  assert.deepEqual(await port.uploadReference?.(projectId, file), video);
  assert.ok(calls[0]!.init.body instanceof FormData);
  assert.equal(new Headers(calls[0]!.init.headers).has('content-type'), false);
  assert.equal((calls[0]!.init.body as FormData).get('projectId'), projectId);
  assert.equal((calls[0]!.init.body as FormData).get('file'), file);
  assert.deepEqual(await port.extractReferenceFrame?.({ projectId, assetId: video.id, frame: 'first' }), frame);
  assert.equal(calls[1]!.url, `/api/assets/${video.id}/frames`);
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { projectId, frame: 'first' });
});

test('Ollama video context is explicit, renders durable sampling disclosure, and analysis can seed a proposal', async () => {
  let streamed: any; let proposed: any;
  const port = { models: async () => [conversation.modelId], list: async () => [conversation], create: async () => conversation, rename: async () => conversation,
    stream: async (input: any, _signal: AbortSignal, emit: (event: any) => void) => { streamed = input; emit({ event: 'done', data: { content: 'Done', usage: null } }); }, propose: async (input: any) => { proposed = input; return { id: 'p', shotId: shot.id, instruction: input.instruction, before: { ...shot, prompt: 'Old' }, after: { title: 'Door', prompt: 'New' }, rationale: null, status: 'pending', appliedRevision: null }; },
    applyProposal: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); } };
  const ui = await mount(port);
  try {
    assert.match(ui.element.textContent ?? '', /2 sampled frames/i);
    assert.match(ui.element.textContent ?? '', /0\.000s.*7\.967s/i);
    assert.match(ui.element.textContent ?? '', /audio not analyzed/i);
    assert.doesNotMatch(ui.element.textContent ?? '', /raw video.*forwarded/i);
    const checkbox = ui.element.querySelector(`input[value="${video.id}"]`) as HTMLInputElement;
    await React.act(async () => fireEvent.click(checkbox));
    const textarea = ui.element.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
    await React.act(async () => fireEvent.change(textarea, { target: { value: 'Analyze movement' } }));
    await React.act(async () => button('Send')!.click());
    assert.deepEqual(streamed.context.assetIds, [video.id]);
    await React.act(async () => button('Use analysis for shot edit')!.click());
    const instruction = ui.element.querySelector('textarea[aria-label="Shot edit instruction"]') as HTMLTextAreaElement;
    await React.act(async () => fireEvent.change(instruction, { target: { value: 'Use the analysis' } }));
    await React.act(async () => button('Request proposal')!.click());
    assert.equal(proposed.sourceMessageId, conversation.messages[0].id);
  } finally { await ui.close(); }
});

test('paste uploads one local file, refreshes authoritatively, and extraction requires explicit safe binding', async () => {
  let uploaded: File | undefined; const extracted: string[] = []; const used: any[] = [];
  const port = { models: async () => [conversation.modelId], list: async () => [{ ...conversation, messages: [] }], create: async () => conversation, rename: async () => conversation, stream: async () => {}, propose: async () => { throw Error('unused'); }, applyProposal: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); },
    uploadReference: async (_projectId: string, file: File) => { uploaded = file; return video; }, extractReferenceFrame: async ({ frame: which }: any) => { extracted.push(which); return frame; } };
  let refreshes = 0;
  const ui = await mount(port, { onWorkspaceRefresh: async () => { refreshes++; }, onUseReferenceFrame: async (input: any) => { used.push(input); } });
  try {
    const file = new File(['video'], 'walkthrough.mp4', { type: 'video/mp4' });
    await React.act(async () => fireEvent.paste(ui.element.querySelector('textarea[aria-label="Message"]')!, { clipboardData: { files: [file], getData: () => '' } }));
    assert.equal(uploaded?.name, file.name); assert.equal(refreshes, 1);
    await React.act(async () => button('Extract first frame')!.click());
    assert.deepEqual(extracted, ['first']); assert.equal(refreshes, 2);
    await React.act(async () => button('Use as first frame in saved shot')!.click());
    assert.deepEqual(used, [{ assetId: frame.id, frame: 'first', shotId: shot.id, expectedRevision: shot.revision }]);
  } finally { await ui.close(); }
});

test('oversized and remote URL paste are rejected before upload', async () => {
  let uploads = 0;
  const port = { models: async () => [conversation.modelId], list: async () => [{ ...conversation, messages: [] }], create: async () => conversation, rename: async () => conversation, stream: async () => {}, propose: async () => { throw Error('unused'); }, applyProposal: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); }, uploadReference: async () => { uploads++; return video; } };
  const ui = await mount(port);
  try {
    const oversized = new File([new Uint8Array(32 * 1024 * 1024 + 1)], 'large.mp4', { type: 'video/mp4' });
    await React.act(async () => fireEvent.paste(ui.element.querySelector('textarea[aria-label="Message"]')!, { clipboardData: { files: [oversized], getData: () => '' } }));
    assert.match(ui.element.textContent ?? '', /32 MiB/i); assert.equal(uploads, 0);
    await React.act(async () => fireEvent.paste(ui.element.querySelector('textarea[aria-label="Message"]')!, { clipboardData: { files: [], getData: () => 'https://example.com/video.mp4' } }));
    assert.match(ui.element.textContent ?? '', /remote URLs.*not fetched/i); assert.equal(uploads, 0);
  } finally { await ui.close(); }
});

test('a reference upload resolving after conversation navigation cannot attach to the new conversation', async () => {
  let resolveUpload!: (asset: typeof video) => void;
  const second = { ...conversation, id: '10000000-0000-4000-8000-000000000020', title: 'Second', messages: [] };
  const port = { models: async () => [conversation.modelId], list: async () => [{ ...conversation, messages: [] }, second], create: async () => conversation, rename: async () => conversation, stream: async () => {}, propose: async () => { throw Error('unused'); }, applyProposal: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); }, uploadReference: async () => new Promise<typeof video>(resolve => { resolveUpload = resolve; }) };
  let refreshes = 0;
  const ui = await mount(port, { onWorkspaceRefresh: async () => { refreshes++; } });
  try {
    const file = new File(['video'], 'walkthrough.mp4', { type: 'video/mp4' });
    await React.act(async () => fireEvent.paste(ui.element.querySelector('textarea[aria-label="Message"]')!, { clipboardData: { files: [file], getData: () => '' } }));
    await React.act(async () => button('Second')!.click());
    await React.act(async () => resolveUpload(video));
    assert.equal((ui.element.querySelector(`input[value="${video.id}"]`) as HTMLInputElement).checked, false);
    assert.equal(refreshes, 0);
    assert.equal(button('Attach file')?.disabled, false);
  } finally { await ui.close(); }
});

test('live context metadata survives done and canonical assistant identity immediately seeds a proposal', async () => {
  const serverId = '10000000-0000-4000-8000-000000000099'; let proposed: any;
  const port = { models: async () => [conversation.modelId], list: async () => [{ ...conversation, messages: [] }], create: async () => conversation, rename: async () => conversation,
    stream: async (_input: any, _signal: AbortSignal, emit: (event: any) => void) => { emit({ event: 'context', data: { references: [reference] } }); emit({ event: 'delta', data: { text: 'The subject ' } }); emit({ event: 'done', data: { assistantMessageId: serverId, status: 'completed', content: 'The subject crosses frame.', usage: null, message: null } }); },
    propose: async (input: any) => { proposed = input; return { id: 'p-live', shotId: shot.id, instruction: input.instruction, before: { ...shot, prompt: 'Old' }, after: { title: 'Door', prompt: 'New' }, rationale: null, status: 'pending', appliedRevision: null, referenceSource: { messageId: serverId, content: 'The subject crosses frame.', references: [reference] } }; }, applyProposal: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); } };
  const ui = await mount(port);
  try {
    const textarea = ui.element.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
    await React.act(async () => fireEvent.change(textarea, { target: { value: 'Analyze movement' } }));
    await React.act(async () => button('Send')!.click());
    const live = [...ui.element.querySelectorAll('[data-role="assistant"]')].at(-1) as HTMLElement;
    assert.equal(live.dataset.messageId, serverId);
    assert.match(live.textContent ?? '', /2 sampled frames.*0\.000s.*7\.967s.*audio not analyzed/i);
    await React.act(async () => (live.querySelector('button') as HTMLButtonElement).click());
    await React.act(async () => fireEvent.change(ui.element.querySelector('textarea[aria-label="Shot edit instruction"]')!, { target: { value: 'Use live analysis' } }));
    await React.act(async () => button('Request proposal')!.click());
    assert.equal(proposed.sourceMessageId, serverId);
  } finally { await ui.close(); }
});

test('derived frames remain bound to their immutable source video', async () => {
  const used: any[] = [];
  const port = { models: async () => [conversation.modelId], list: async () => [{ ...conversation, messages: [] }], create: async () => conversation, rename: async () => conversation, stream: async () => {}, propose: async () => { throw Error('unused'); }, applyProposal: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); },
    extractReferenceFrame: async ({ assetId }: any) => assetId === video.id ? frame : frameB };
  const ui = await mount(port, { assets: [video, videoB], onWorkspaceRefresh: async () => {}, onUseReferenceFrame: async (input: any) => { used.push(input); } });
  try {
    const rows = [...ui.element.querySelectorAll('.fl-chat__video-actions')] as HTMLElement[];
    await React.act(async () => (rows[0]!.querySelector('button') as HTMLButtonElement).click());
    assert.equal(rows[1]!.textContent?.includes('Use as first frame'), false);
    await React.act(async () => (rows[1]!.querySelector('button') as HTMLButtonElement).click());
    const useB = [...rows[1]!.querySelectorAll('button')].find(item => item.textContent === 'Use as first frame in saved shot')!;
    await React.act(async () => useB.click());
    assert.equal(used[0].assetId, frameB.id);
  } finally { await ui.close(); }
});

test('pending media work cannot refresh or bind after project navigation and releases busy state', async () => {
  let resolveExtract!: (asset: typeof frame) => void; let refreshes = 0; const used: any[] = [];
  const otherProject = '20000000-0000-4000-8000-000000000001';
  const port = { models: async () => [conversation.modelId], list: async (id: string) => [{ ...conversation, projectId: id, id: id === projectId ? conversation.id : '20000000-0000-4000-8000-000000000010', messages: [] }], create: async () => conversation, rename: async () => conversation, stream: async () => {}, propose: async () => { throw Error('unused'); }, applyProposal: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); }, uploadReference: async () => video, extractReferenceFrame: async () => new Promise<typeof frame>(resolve => { resolveExtract = resolve; }) };
  const ui = await mount(port, { onWorkspaceRefresh: async () => { refreshes++; }, onUseReferenceFrame: async (input: any) => { used.push(input); } });
  try {
    await React.act(async () => button('Extract first frame')!.click());
    await ui.render(port, { project: { id: otherProject, name: 'Other' }, shot: undefined, assets: [] });
    await React.act(async () => resolveExtract(frame));
    assert.equal(refreshes, 0); assert.deepEqual(used, []);
    assert.equal(button('Attach file')?.disabled, false);
  } finally { await ui.close(); }
});

test('media work blocks Send and Enter, conversation switch clears attachments, and a full selection explains saved-only upload', async () => {
  let resolveUpload!: (asset: typeof videoB) => void; let streams = 0;
  const second = { ...conversation, id: '10000000-0000-4000-8000-000000000020', title: 'Second', messages: [] };
  const stills = [0, 1, 2, 3].map(index => ({ ...frame, id: `30000000-0000-4000-8000-00000000000${index}`, filename: `${index}.png`, mediaUrl: `/api/media/${index}` }));
  const port = { models: async () => [conversation.modelId], list: async () => [{ ...conversation, messages: [] }, second], create: async () => conversation, rename: async () => conversation, stream: async () => { streams++; }, propose: async () => { throw Error('unused'); }, applyProposal: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); }, uploadReference: async () => new Promise<typeof videoB>(resolve => { resolveUpload = resolve; }) };
  const ui = await mount(port, { assets: [...stills, videoB], onWorkspaceRefresh: async () => {} });
  try {
    for (const asset of stills) await React.act(async () => fireEvent.click(ui.element.querySelector(`input[value="${asset.id}"]`)!));
    const message = ui.element.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
    await React.act(async () => fireEvent.change(message, { target: { value: 'Analyze' } }));
    await React.act(async () => fireEvent.paste(message, { clipboardData: { files: [new File(['v'], 'second.mp4', { type: 'video/mp4' })], getData: () => '' } }));
    assert.equal(button('Send')?.disabled, true);
    await React.act(async () => fireEvent.keyDown(message, { key: 'Enter' })); assert.equal(streams, 0);
    await React.act(async () => resolveUpload(videoB));
    assert.match(ui.element.textContent ?? '', /saved to the library.*could not be attached.*four/i);
    assert.equal((ui.element.querySelector(`input[value="${videoB.id}"]`) as HTMLInputElement).checked, false);
    await React.act(async () => button('Second')!.click());
    for (const asset of stills) assert.equal((ui.element.querySelector(`input[value="${asset.id}"]`) as HTMLInputElement).checked, false);
  } finally { await ui.close(); }
});

test('selected references use safe owned previews and disclose bounded discontinuous sampling', async () => {
  const unsafe = { ...frame, id: '40000000-0000-4000-8000-000000000001', filename: 'unsafe.png', mediaUrl: 'https://example.invalid/private.png' };
  const port = { models: async () => [conversation.modelId], list: async () => [{ ...conversation, messages: [] }], create: async () => conversation, rename: async () => conversation, stream: async () => {}, propose: async () => { throw Error('unused'); }, applyProposal: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); } };
  const ui = await mount(port, { assets: [video, unsafe] });
  try {
    await React.act(async () => fireEvent.click(ui.element.querySelector(`input[value="${video.id}"]`)!));
    const preview = ui.element.querySelector('.fl-chat__selected-preview video') as HTMLVideoElement;
    assert.equal(preview.getAttribute('src'), video.mediaUrl);
    assert.match(ui.element.textContent ?? '', /up to 60 seconds.*up to 16 frames.*gaps.*audio.*not analyzed/i);
    await React.act(async () => fireEvent.click(ui.element.querySelector(`input[value="${unsafe.id}"]`)!));
    assert.equal(ui.element.querySelector(`img[src="${unsafe.mediaUrl}"]`), null);
  } finally { await ui.close(); }
});

test('reloaded proposal renders immutable analysis provenance separately from generation frame bindings', async () => {
  const proposal = { id: 'p-saved', shotId: shot.id, instruction: 'Match the walk', before: { ...shot, prompt: 'Old' }, after: { title: 'Door', prompt: 'New' }, rationale: null, status: 'pending', appliedRevision: null, referenceSource: { messageId: conversation.messages[0].id, content: conversation.messages[0].content, references: [reference] } };
  const port = { models: async () => [conversation.modelId], list: async () => [{ ...conversation, proposals: [proposal] }], create: async () => conversation, rename: async () => conversation, stream: async () => {}, propose: async () => proposal, applyProposal: async () => proposal, dismissProposal: async () => proposal };
  const ui = await mount(port);
  try { assert.match(ui.element.textContent ?? '', /guided by saved analysis.*original video.*not forwarded/i); assert.match(ui.element.textContent ?? '', /generation frame bindings.*separate actual images/i); }
  finally { await ui.close(); }
});
