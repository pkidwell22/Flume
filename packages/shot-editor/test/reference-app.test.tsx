import './setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FlumeApp } from '../../../apps/web/src/App.tsx';
import { WorkspaceController } from '../../../apps/web/src/controller.ts';
import { workspaceComponents } from '../../../apps/web/src/composition.ts';
import type { Asset, Command, Workspace } from '../../../apps/web/src/types.ts';
import { assets, capabilities, shot } from './fixtures.ts';

afterEach(cleanup);
// DOM-only adapters. Real focus, details activation and decoding have a separate native witness.
Object.assign(window.HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); }, close(this: HTMLDialogElement) { this.removeAttribute('open'); },
});
HTMLElement.prototype.scrollIntoView = function () {};
const project = { id: shot.projectId, name: 'Reference integration fixture', brief: '', revision: 1 };
const asset = (id: string): Asset => ({ ...assets[1]!, id, filename: `${id}.png`, mediaUrl: `/api/media/${id}`, origin: 'imported' });
const initial = (): Workspace => ({ project, shots: [{ ...structuredClone(shot), selectedTakeId: null, selectionRevision: 0 }], assets: [...assets, asset('C'), asset('D')], capabilities: capabilities.map(c => ({ ...c, durations: [...c.durations], resolutions: [...c.resolutions], frameRoles: [...c.frameRoles], aspectRatios: c.aspectRatios ? [...c.aspectRatios] : undefined })), takes: [], attempts: [], reviews: [], exports: [] });
const editor = () => within(screen.getByRole('region', { name: 'Shot editor' }));
const field = (name: string) => editor().getByLabelText(name) as HTMLInputElement;
const button = (name: string) => editor().getByRole('button', { name }) as HTMLButtonElement;
const trigger = (role: string) => editor().getByLabelText(`${role} frame reference`);
const disclosure = (role: string) => trigger(role).closest('details')!;
const open = (role: string) => { if (!disclosure(role).open) fireEvent.click(trigger(role)); };
const choose = (role: string, value: string) => { open(role); fireEvent.change(field(`${role} frame image`), { target: { value } }); };
const bindings = () => ({ firstFrameAssetId: field('Start frame image').value || null, lastFrameAssetId: field('End frame image').value || null });
const model = (name: string) => { fireEvent.click(button('Model')); fireEvent.click(screen.getByRole('option', { name })); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount(options: { workspace?: Workspace; upload?: (file: File) => Promise<Asset>; approved?: boolean; blockers?: string[] } = {}) {
  let ws = options.workspace ?? initial(); const commands: Command[] = [], uploads: { file: File; projectId: string }[] = [];
  const controller = new WorkspaceController({
    listProjects: async () => [project], getWorkspace: async () => structuredClone(ws),
    uploadAsset: async (file, projectId) => {
      uploads.push({ file, projectId }); const result = await (options.upload?.(file) ?? Promise.resolve(asset('C')));
      ws.assets = [...ws.assets.filter(a => a.id !== result.id), result]; return result;
    },
    command: async command => {
      commands.push(structuredClone(command));
      if (command.type === 'shot.update') {
        const current = ws.shots.find(s => s.id === command.shotId)!;
        const { seed, ...controls } = { ...current.controls, ...command.patch.controls };
        ws.shots = ws.shots.map(s => s === current ? { ...s, ...command.patch, controls: { ...controls, ...(seed == null ? {} : { seed }) }, bindings: { ...s.bindings, ...command.patch.bindings }, revision: command.expectedRevision + 1 } : s);
        return { commandId: command.commandId, projectId: project.id, revision: command.expectedRevision + 1 };
      }
      if (command.type === 'generation.prepare') {
        const current = ws.shots.find(s => s.id === command.shotId)!;
        ws.reviews = [{ id: 'fixture-review', projectId: project.id, shotId: current.id, shotRevision: current.revision, requestHash: 'fixture-only', prompt: current.prompt, controls: current.controls, bindings: current.bindings, estimatedCostUsd: '0.5', approved: options.approved ?? false, blockers: options.blockers ?? [] }];
        return { commandId: command.commandId, projectId: project.id, reviewId: 'fixture-review' };
      }
      throw new Error(`Unexpected fixture command: ${command.type}`);
    },
  });
  await controller.openProject(project.id);
  const view = render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  return { controller, commands, uploads, view, workspace: () => ws, setWorkspace: (next: Workspace) => { ws = next; } };
}
const upload = (role: string, file = new File(['fixture bytes'], 'new.png', { type: 'image/png' })) => {
  open(role); fireEvent.change(field(`Upload ${role.toLowerCase()} frame`), { target: { files: [file] } }); return file;
};
const close = (role: string) => fireEvent.click(button(`Close ${role.toLowerCase()} frame picker`));

test('A01 actual App mounts two compact independent roles with scoped choices and no commands', async () => {
  const ws = initial(); ws.assets.push({ ...asset('foreign'), projectId: 'foreign' }, { ...asset('video'), kind: 'video' });
  const h = await mount({ workspace: ws });
  assert.deepEqual(bindings(), shot.bindings);
  for (const role of ['Start', 'End']) {
    assert.equal(disclosure(role).open, false); open(role);
    assert.deepEqual(Array.from((field(`${role} frame image`) as unknown as HTMLSelectElement).options, o => o.value), ['', 'start', 'end', 'C', 'D']);
    close(role);
  }
  assert.equal(h.commands.length, 0); assert.deepEqual(h.uploads, []); assert.equal(h.controller.getSnapshot().dirtyShotIds.size, 0);
});
for (const end of ['end', null]) test(`A02 actual App replaces only End from ${end}; saved identity is authoritative`, async () => {
  const ws = initial(); ws.shots[0]!.bindings.lastFrameAssetId = end;
  const h = await mount({ workspace: ws }); choose('End', 'C'); close('End');
  assert.deepEqual(bindings(), { firstFrameAssetId: 'start', lastFrameAssetId: 'C' });
  assert.deepEqual(h.workspace().shots[0]!.bindings, { firstFrameAssetId: 'start', lastFrameAssetId: end }, 'choosing is draft-only');
  assert.equal(h.controller.getSnapshot().dirtyShotIds.has(shot.id), true); assert.equal(h.commands.length, 0); assert.deepEqual(h.uploads, []);
  await act(async () => fireEvent.click(button('Save changes')));
  assert.equal(h.commands.length, 1); const command = h.commands[0]!; assert.equal(command.type, 'shot.update');
  if (command.type !== 'shot.update') throw Error('Wrong command');
  assert.equal(command.expectedRevision, 3); assert.deepEqual(command.patch.bindings, bindings());
  assert.equal(command.patch.prompt, shot.prompt); assert.deepEqual(command.patch.controls, shot.controls);
  assert.deepEqual(h.workspace().shots[0]!.bindings, bindings()); assert.equal(h.controller.getSnapshot().dirtyShotIds.size, 0);
});
test('A03 actual App reselecting the bound image stays clean and close has no extra intent', async () => {
  const h = await mount(); choose('End', 'end'); close('End');
  assert.deepEqual(bindings(), shot.bindings); assert.equal(button('Save changes').disabled, true);
  assert.equal(h.controller.getSnapshot().dirtyShotIds.size, 0); assert.equal(h.commands.length, 0); assert.deepEqual(h.uploads, []);
});
test('A04 actual App separate End clear keeps owned asset and Start; never demotes or deletes', async () => {
  const h = await mount(); open('End'); fireEvent.click(button('Clear end frame')); close('End');
  assert.deepEqual(bindings(), { firstFrameAssetId: 'start', lastFrameAssetId: null });
  assert.ok(h.workspace().assets.some(a => a.id === 'end')); assert.equal(h.commands.length, 0); assert.deepEqual(h.uploads, []);
  assert.equal(h.controller.getSnapshot().dirtyShotIds.has(shot.id), true); assert.equal(button('Review generation').disabled, true);
});
test('A05 actual App same-image reuse is explicit and preserves both stable IDs', async () => {
  const h = await mount(); choose('End', 'start'); close('End');
  assert.deepEqual(bindings(), { firstFrameAssetId: 'start', lastFrameAssetId: 'start' });
  assert.deepEqual(h.uploads, []); assert.equal(h.commands.length, 0);
  assert.doesNotMatch(editor().getByRole('group', { name: 'Frame references' }).textContent!, /extracted output/i);
});
test('A06 actual App pending replacement stays visible after close, keeps old ID and newer prompt', async () => {
  const d = deferred<Asset>(); const h = await mount({ upload: () => d.promise }); const file = upload('End'); close('End');
  assert.equal(h.uploads.length, 1); assert.ok(h.uploads[0]!.file === file); assert.equal(h.uploads[0]!.projectId, project.id);
  assert.deepEqual(bindings(), shot.bindings); assert.match(disclosure('End').parentElement!.textContent!, /Importing new.png/);
  assert.equal(button('Save changes').disabled, true); assert.equal(button('Review generation').disabled, true);
  fireEvent.change(field('Prompt'), { target: { value: 'Newer draft while replacing' } }); field('Prompt').focus();
  await act(async () => d.resolve(asset('C')));
  assert.deepEqual(bindings(), { firstFrameAssetId: 'start', lastFrameAssetId: 'C' });
  assert.equal(field('Prompt').value, 'Newer draft while replacing'); assert.equal(disclosure('End').open, false);
  assert.ok(document.activeElement === field('Prompt')); assert.equal(h.commands.length, 0);
  assert.deepEqual(h.workspace().shots[0]!.bindings, shot.bindings, 'upload did not save bindings');
});
for (const kind of ['unsupported', 'empty', 'oversized', 'reject', 'foreign', 'video']) test(`A07 actual App ${kind} upload cannot erase End`, async () => {
  const h = await mount({ upload: async () => { if (kind === 'reject') throw Error('Fixture decode rejection'); return { ...asset('C'), ...(kind === 'foreign' ? { projectId: 'foreign' } : {}), ...(kind === 'video' ? { kind: 'video' as const } : {}) }; } });
  const file = new File(kind === 'empty' ? [] : ['fixture'], kind === 'unsupported' ? 'bad.pdf' : 'new.png', { type: kind === 'unsupported' ? 'application/pdf' : 'image/png' });
  if (kind === 'oversized') Object.defineProperty(file, 'size', { value: 20 * 1024 * 1024 + 1 });
  await act(async () => { upload('End', file); }); close('End');
  assert.equal(h.uploads.length, ['unsupported', 'empty', 'oversized'].includes(kind) ? 0 : 1);
  assert.deepEqual(bindings(), shot.bindings); assert.ok(disclosure('End').parentElement!.querySelector('[aria-live="polite"]')?.textContent);
  assert.equal(h.commands.length, 0); assert.equal(h.controller.getSnapshot().dirtyShotIds.size, 0);
});
for (const action of ['clear', 'choose']) test(`A08 actual App ${action} beats delayed replacement even when disclosure is closed`, async () => {
  const d = deferred<Asset>(); const h = await mount({ upload: () => d.promise }); upload('End');
  if (action === 'clear') fireEvent.click(button('Clear end frame')); else choose('End', 'D'); close('End');
  await act(async () => d.resolve(asset('C')));
  assert.deepEqual(bindings(), { firstFrameAssetId: 'start', lastFrameAssetId: action === 'clear' ? null : 'D' });
  assert.match(disclosure('End').parentElement!.textContent!, /Imported C.png but did not attach/);
  assert.equal(disclosure('End').open, false); assert.equal(h.commands.length, 0);
});
test('A09 actual App serializes side-effect uploads; both local roles remain independently editable', async () => {
  const d = deferred<Asset>(); const h = await mount({ upload: () => d.promise }); upload('End'); open('Start');
  assert.equal(field('Upload start frame').disabled, true); assert.equal(field('Upload end frame').disabled, true);
  await act(async () => { upload('Start'); }); assert.equal(h.uploads.length, 1, 'even late file delivery cannot bypass busy guard');
  choose('Start', 'D'); close('Start'); close('End');
  await act(async () => d.resolve(asset('C')));
  assert.deepEqual(bindings(), { firstFrameAssetId: 'D', lastFrameAssetId: 'C' }); assert.equal(h.commands.length, 0);
});
for (const fence of ['model-roundtrip', 'new-revision', 'dirty-conflict', 'unmount']) test(`A10 actual App ${fence} fences late End attachment`, async () => {
  const d = deferred<Asset>(); const h = await mount({ upload: () => d.promise }); upload('End'); close('End');
  if (fence === 'model-roundtrip') { model('Start-only model'); model('Paired-frame model'); }
  if (fence === 'dirty-conflict') fireEvent.change(field('Prompt'), { target: { value: 'New local prompt' } });
  if (fence === 'new-revision' || fence === 'dirty-conflict') h.workspace().shots[0] = { ...h.workspace().shots[0]!, revision: 4, prompt: 'Remote update' };
  if (fence === 'unmount') h.view.unmount();
  await act(async () => d.resolve(asset('C')));
  if (fence === 'unmount') { assert.ok(!screen.queryByRole('region', { name: 'Shot editor' })); return; }
  assert.equal(field('End frame image').value, 'end'); assert.equal(disclosure('End').open, false);
  assert.match(disclosure('End').parentElement!.textContent!, /Imported C.png but did not attach/);
  choose('End', 'C'); assert.equal(field('End frame image').value, 'C'); assert.equal(h.commands.length, 0);
});
for (const fence of ['shot-switch', 'project-switch']) test(`A10 actual App ${fence} remount retires a held reference session`, async () => {
  const d = deferred<Asset>(); const ws = initial();
  ws.shots.push({ ...ws.shots[0]!, id: 'second', bindings: { firstFrameAssetId: null, lastFrameAssetId: null } });
  const h = await mount({ workspace: ws, upload: () => d.promise }); upload('End');
  assert.equal(h.controller.selectShot('second'), false, 'ordinary busy navigation is refused');
  // A workspace read/session replacement can still arrive independently of UI navigation.
  const next = initial(); next.shots[0] = { ...next.shots[0]!, id: fence === 'shot-switch' ? 'second' : shot.id,
    projectId: fence === 'project-switch' ? 'other-project' : shot.projectId,
    prompt: 'New session', bindings: { firstFrameAssetId: null, lastFrameAssetId: null } };
  if (fence === 'project-switch') next.project = { ...project, id: 'other-project' };
  h.setWorkspace(next); await act(async () => h.controller.openProject(next.project!.id));
  await act(async () => d.resolve(asset('C')));
  assert.deepEqual(bindings(), { firstFrameAssetId: null, lastFrameAssetId: null });
  assert.equal(disclosure('End').open, false); assert.equal(disclosure('Start').open, false);
  assert.equal(field('Prompt').value, 'New session'); assert.doesNotMatch(disclosure('End').parentElement!.textContent!, /Importing|Imported/);
  assert.equal(h.commands.length, 0);
});
test('A11 actual App incompatible model keeps both identities, editable roles and exact saved intent', async () => {
  const h = await mount({ blockers: ['Fixture model has no end-frame support'] }); model('Start-only model');
  open('Start'); open('End'); close('Start'); close('End');
  assert.deepEqual(bindings(), shot.bindings); assert.match(screen.getByRole('region', { name: 'Model compatibility' }).textContent!, /not become a soft reference/);
  await act(async () => fireEvent.click(button('Save changes'))); await act(async () => fireEvent.click(button('Review generation')));
  assert.deepEqual(h.commands.map(c => c.type), ['shot.update', 'generation.prepare']);
  assert.deepEqual(h.workspace().reviews[0]!.bindings, shot.bindings);
  assert.equal((screen.getByRole('button', { name: 'Approve this generation' }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole('button', { name: 'Generate once' }) as HTMLButtonElement).disabled, true);
});
for (const approved of [false, true]) for (const media of ['missing', 'unloaded', 'failed', 'loaded']) test(`A12 actual App ${media} End gates ${approved ? 'submission' : 'approval'}`, async () => {
  const ws = initial(); if (media === 'missing') ws.assets = ws.assets.filter(a => a.id !== 'end');
  const h = await mount({ workspace: ws, approved });
  assert.equal(field('End frame image').value, 'end');
  if (media === 'missing') assert.match(trigger('End').textContent!, /Unavailable image: end/);
  await act(async () => fireEvent.click(button('Review generation')));
  const dialog = within(screen.getByRole('dialog'));
  const images = dialog.queryAllByRole('img'); fireEvent.load(images[0]!);
  if (media === 'failed') fireEvent.error(images[1]!); if (media === 'loaded') fireEvent.load(images[1]!);
  const action = dialog.getByRole('button', { name: approved ? 'Generate once' : 'Approve this generation' }) as HTMLButtonElement;
  assert.equal(action.disabled, media !== 'loaded'); assert.deepEqual(h.commands.map(c => c.type), ['generation.prepare']);
  assert.deepEqual(h.workspace().reviews[0]!.bindings, shot.bindings);
});
test('A13 actual App Escape and explicit close restore the matching trigger with no dirty or business effects', async () => {
  const h = await mount();
  for (const role of ['Start', 'End']) {
    open(role); field(`${role} frame image`).focus(); fireEvent.keyDown(field(`${role} frame image`), { key: 'Escape' });
    assert.equal(disclosure(role).open, false); assert.ok(document.activeElement === trigger(role));
    open(role); close(role); assert.equal(disclosure(role).open, false); assert.ok(document.activeElement === trigger(role));
  }
  assert.deepEqual(bindings(), shot.bindings); assert.equal(h.controller.getSnapshot().dirtyShotIds.size, 0);
  assert.equal(h.commands.length, 0); assert.deepEqual(h.uploads, []);
});
for (const pair of [[null, null], ['start', null], [null, 'end'], ['start', 'end']] as const) test(`A14 conditional only: actual App preserves nullable workflow ${JSON.stringify(pair)}`, async () => {
  const ws = initial(); ws.shots[0]!.bindings = { firstFrameAssetId: pair[0], lastFrameAssetId: pair[1] };
  const h = await mount({ workspace: ws }); await act(async () => fireEvent.click(button('Review generation')));
  for (const image of within(screen.getByRole('dialog')).queryAllByRole('img')) fireEvent.load(image);
  assert.equal((screen.getByRole('button', { name: 'Approve this generation' }) as HTMLButtonElement).disabled, false, 'no invented pair requirement or TTV ban');
  assert.deepEqual(h.commands.map(c => c.type), ['generation.prepare']);
});
