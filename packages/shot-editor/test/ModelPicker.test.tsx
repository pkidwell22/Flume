import './setup.ts';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CapabilityView } from '../src/types.ts';
import { useState } from 'react';
import { createEditorState, editDraft, isDirty } from '../src/editor-state.ts';
import { shot } from './fixtures.ts';

// This is the actual blocked route in apps/server/src/ports.ts, after the
// existing composition.ts first/last -> first_frame/last_frame projection.
const h3: CapabilityView = {
  modelId: 'minimax/hailuo-3',
  name: 'Hailuo 3',
  durations: [5],
  resolutions: ['2K'],
  frameRoles: ['first_frame', 'last_frame'],
  seedSupported: false,
  availability: 'blocked',
  blocker: 'Provider integration is not configured. Editing and local imports remain available.',
};

// Synthetic records exist only in tests to exercise multi-result behavior.
const unknownRoute: CapabilityView = { ...h3, modelId: 'fixture/unknown', name: 'Unknown route (test fixture)', availability: 'unknown', blocker: null, durations: [], resolutions: [], frameRoles: [] };
const literalRoute: CapabilityView = { ...h3, modelId: '  fixture/Mixed-ID  ', name: 'Available route (test fixture)', availability: 'available', blocker: null, seedSupported: true };

afterEach(cleanup);

test('renders only supplied model names and metadata without inventing routes or prices', async () => {
  assert.ok(existsSync(new URL('../src/ModelPicker.tsx', import.meta.url)), 'ModelPicker component must exist');
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const changed: string[] = [];
  render(<ModelPicker value={h3.modelId} capabilities={[h3]} onChange={(id) => changed.push(id)} />);
  const trigger = screen.getByRole('button', { name: 'Model' });
  assert.match(trigger.textContent!, /Hailuo 3/);
  assert.match(trigger.textContent!, /minimax\/hailuo-3/);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  fireEvent.click(trigger);
  const option = screen.getByRole('option', { name: 'Hailuo 3' });
  assert.equal(screen.getAllByRole('option').length, 1);
  assert.equal(option.getAttribute('aria-selected'), 'true');
  for (const content of ['5 s', '2K', 'Start frame', 'End frame', 'Seed not supported', 'Route unavailable', h3.blocker!]) {
    assert.ok(within(option).getByText(content), content);
  }
  assert.doesNotMatch(option.textContent!, /\$|credits|1080p|audio|16:9|Cinema Studio/);
  assert.deepEqual(changed, []);
});

test('focuses search, matches names, literal IDs and capability metadata, and recovers an empty result', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const changed: string[] = [];
  render(<ModelPicker value={h3.modelId} capabilities={[h3]} onChange={(id) => changed.push(id)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  const search = screen.queryByRole('combobox', { name: 'Search models' });
  assert.ok(search !== null, 'Open picker exposes a searchable combobox');
  assert.ok(document.activeElement === search, 'Opening focuses search');
  for (const query of ['HAILUO', 'minimax/hailuo-3', '  2k   5 s  ', 'end frame', 'unavailable']) {
    fireEvent.change(search!, { target: { value: query } });
    assert.equal(screen.getAllByRole('option').length, 1, query);
  }
  fireEvent.change(search!, { target: { value: 'not a model' } });
  assert.equal(screen.queryAllByRole('option').length, 0);
  assert.match(screen.getByRole('status').textContent!, /No matching models/);
  assert.match(screen.getByRole('button', { name: 'Model' }).textContent!, /Hailuo 3/);
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  assert.equal((search as HTMLInputElement).value, '');
  assert.ok(document.activeElement === search, 'Clearing restores search focus');
  assert.equal(screen.getAllByRole('option').length, 1);
  assert.deepEqual(changed, [], 'Searching never changes draft identity');
});

test('keyboard exploration changes only the active result until Enter requests a literal controlled value', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const changed: string[] = [];
  const props = { value: h3.modelId, capabilities: [h3, unknownRoute, literalRoute], onChange: (id: string) => changed.push(id) };
  const view = render(<ModelPicker {...props} />);
  const trigger = screen.getByRole('button', { name: 'Model' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'ArrowDown opens picker');
  const search = screen.getByRole('combobox', { name: 'Search models' });
  const activeName = () => document.getElementById(search.getAttribute('aria-activedescendant')!)?.getAttribute('aria-labelledby');
  const activeText = () => document.getElementById(activeName()!)?.textContent;
  assert.equal(activeText(), h3.name);
  fireEvent.keyDown(search, { key: 'ArrowUp' });
  assert.equal(activeText(), literalRoute.name, 'ArrowUp wraps to final result');
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  assert.equal(activeText(), h3.name, 'ArrowDown wraps to first result');
  fireEvent.keyDown(search, { key: 'End', ctrlKey: true });
  assert.equal(activeText(), literalRoute.name);
  fireEvent.keyDown(search, { key: 'Home' });
  assert.equal(activeText(), literalRoute.name, 'Plain Home remains a text-editing key');
  fireEvent.keyDown(search, { key: 'Home', ctrlKey: true });
  assert.equal(activeText(), h3.name);
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  assert.equal(activeText(), unknownRoute.name);
  assert.deepEqual(changed, [], 'Navigation never selects');
  fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
  assert.deepEqual(changed, [], 'IME confirmation never selects');
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  fireEvent.keyDown(search, { key: 'Enter' });
  assert.deepEqual(changed, [literalRoute.modelId], 'Whitespace and casing in IDs remain literal');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.ok(document.activeElement === trigger, 'Selection returns focus to trigger');
  assert.match(trigger.textContent!, /Hailuo 3/, 'No optimistic internal selection');
  view.rerender(<ModelPicker {...props} value={literalRoute.modelId} />);
  assert.equal(trigger.getAttribute('value'), literalRoute.modelId);
  fireEvent.click(trigger);
  assert.equal(screen.getByRole('option', { name: literalRoute.name }).getAttribute('aria-selected'), 'true');
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  assert.equal(changed.length, 1, 'Reselecting the same model is a no-op');
});

test('keeps an unlisted selected ID verbatim through catalog loss without inventing a replacement model', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const changed: string[] = [];
  const missing = '  Keep/THIS-unknown-ID  ';
  const props = { value: missing, capabilities: [h3], onChange: (id: string) => changed.push(id) };
  const view = render(<ModelPicker {...props} />);
  const trigger = screen.getByRole('button', { name: 'Model' });
  assert.equal(trigger.getAttribute('value'), missing);
  assert.match(trigger.textContent!, /Not in catalog/, 'Missing model is not presented as available');
  assert.ok(screen.getByText(missing, { exact: true, normalizer: (text) => text }));
  fireEvent.click(trigger);
  assert.equal(screen.getAllByRole('option').length, 1, 'No fabricated fallback catalog entry');
  view.rerender(<ModelPicker {...props} capabilities={[]} />);
  assert.equal(trigger.getAttribute('value'), missing);
  assert.equal(screen.queryAllByRole('option').length, 0);
  assert.match(screen.getByRole('status').textContent!, /No models in the current catalog/);
  const search = screen.getByRole('combobox');
  assert.equal(search.hasAttribute('aria-activedescendant'), false);
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) fireEvent.keyDown(search, { key });
  assert.deepEqual(changed, []);
  view.rerender(<ModelPicker {...props} value="" capabilities={[]} />);
  assert.match(trigger.textContent!, /Choose a model/);
  assert.equal(trigger.getAttribute('value'), '');
});

test('distinguishes available, unavailable and unverified routes while keeping each selectable as draft intent', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const changed: string[] = [];
  render(<ModelPicker value="" capabilities={[h3, unknownRoute, literalRoute]} onChange={(id) => changed.push(id)} />);
  const trigger = screen.getByRole('button', { name: 'Model' });
  for (const [model, label] of [[h3, 'Route unavailable'], [unknownRoute, 'Route not verified'], [literalRoute, 'Route available']] as const) {
    fireEvent.click(trigger);
    const option = screen.getByRole('option', { name: model.name });
    assert.ok(within(option).getByText(label));
    if (model === unknownRoute) {
      assert.equal(within(option).getAllByText('Not listed').length, 3);
      assert.match(option.textContent!, /Access has not been verified/);
    }
    fireEvent.click(option);
    assert.equal(changed.at(-1), model.modelId);
  }
  assert.match(screen.getByText(/Other settings and frames stay unchanged/).textContent!, /review/);
});

test('Escape returns focus but outside pointer and Tab-style focus departure dismiss without stealing it', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const changed: string[] = [];
  render(<><ModelPicker value={h3.modelId} capabilities={[h3]} onChange={(id) => changed.push(id)} /><button type="button">After picker</button></>);
  const trigger = screen.getByRole('button', { name: 'Model' });
  const after = screen.getByRole('button', { name: 'After picker' });
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'Escape closes panel');
  assert.ok(document.activeElement === trigger);
  fireEvent.click(trigger);
  act(() => after.focus());
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'Focus outside dismisses');
  assert.ok(document.activeElement === after, 'No dismissal focus theft');
  fireEvent.click(trigger);
  fireEvent.pointerDown(after);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'Outside pointer dismisses');
  assert.ok(document.activeElement !== trigger, 'Pointer dismissal never restores old anchor focus');
  assert.deepEqual(changed, []);
});

test('disabled busy policy blocks opening and dismisses an already open picker without accepting stale input', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const changed: string[] = [];
  const props = { value: h3.modelId, capabilities: [h3, unknownRoute], onChange: (id: string) => changed.push(id) };
  const view = render(<ModelPicker {...props} disabled />);
  const trigger = screen.getByRole('button', { name: 'Model' }) as HTMLButtonElement;
  assert.equal(trigger.disabled, true);
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  view.rerender(<ModelPicker {...props} disabled={false} />);
  fireEvent.click(trigger);
  const staleOption = screen.getByRole('option', { name: unknownRoute.name });
  const staleSearch = screen.getByRole('combobox');
  view.rerender(<ModelPicker {...props} disabled />);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'A new busy state closes the chooser');
  assert.equal(screen.queryAllByRole('dialog').length, 0);
  fireEvent.click(staleOption);
  fireEvent.keyDown(staleSearch, { key: 'Enter' });
  assert.deepEqual(changed, []);
  view.rerender(<ModelPicker {...props} disabled={false} />);
  assert.equal(trigger.getAttribute('value'), h3.modelId);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'Unlocking does not reopen the menu');
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  assert.ok(document.activeElement === screen.getByRole('combobox'));
});

test('announces each option capability and route description separately from its name and selected state', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  render(<ModelPicker value={h3.modelId} capabilities={[h3]} onChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  const option = screen.getByRole('option', { name: h3.name });
  const description = (option.getAttribute('aria-describedby') || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
  assert.match(description, /Route unavailable/);
  assert.match(description, /Start frame/);
  assert.match(description, /End frame/);
  assert.match(description, /5 s/);
  assert.ok(within(option).getByText('Selected'));
});

test('busy completion restores only focus owned by this picker without stealing an outside focus', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const element = (disabled: boolean) => <><ModelPicker value={h3.modelId} capabilities={[h3]} disabled={disabled} onChange={() => {}} /><button type="button">Elsewhere</button></>;
  const view = render(element(false));
  const trigger = screen.getByRole('button', { name: 'Model' });
  fireEvent.click(trigger);
  view.rerender(element(true));
  view.rerender(element(false));
  assert.ok(document.activeElement === trigger, 'An interrupted search returns to the trigger when unlocked');
  fireEvent.click(trigger);
  view.rerender(element(true));
  const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
  act(() => elsewhere.focus());
  view.rerender(element(false));
  assert.ok(document.activeElement === elsewhere, 'Unlock does not take focus back after user moves away');
});

test('a dismissed picker does not reclaim focus after a later busy transition', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const element = (disabled: boolean) => <><ModelPicker value={h3.modelId} capabilities={[h3]} disabled={disabled} onChange={() => {}} /><div data-testid="outside-surface">Workspace</div></>;
  const view = render(element(false));
  const trigger = screen.getByRole('button', { name: 'Model' });
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByTestId('outside-surface'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  view.rerender(element(true));
  view.rerender(element(false));
  assert.ok(document.activeElement !== trigger, 'A dismissed picker no longer owns focus');
});

test('controlled editor-state integration preserves incompatible draft settings, both frames and literal prompt', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const state = createEditorState(shot);
  const draft = { ...state.draft, prompt: '  Literal #Dolly\n\n<retain>  ', controls: { ...state.draft.controls, durationSeconds: '', resolution: 'unlisted-resolution', aspectRatio: '9:16', seed: '0', generateAudio: true } };
  const initial = editDraft(state, draft);
  let observed = initial;
  let submissions = 0;
  const calls: unknown[][] = [];
  function ControlledDraft() {
    const [current, setCurrent] = useState(initial);
    observed = current;
    return <form onSubmit={(event) => { event.preventDefault(); submissions++; }}>
      <ModelPicker value={current.draft.controls.modelId} capabilities={[h3, unknownRoute]} onChange={(...args) => {
        calls.push(args);
        setCurrent((previous) => editDraft(previous, { ...previous.draft, controls: { ...previous.draft.controls, modelId: args[0] } }));
      }} />
    </form>;
  }
  render(<ControlledDraft />);
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  fireEvent.click(screen.getByRole('option', { name: h3.name }));
  assert.deepEqual(calls, [[h3.modelId]], 'Callback carries a literal ID only, not replacement settings');
  assert.deepEqual(observed.draft, { ...draft, controls: { ...draft.controls, modelId: h3.modelId } });
  assert.deepEqual(observed.base, initial.base, 'Changing a model cannot promote the saved revision');
  assert.equal(isDirty(observed), true);
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  assert.deepEqual(observed.draft, { ...draft, controls: { ...draft.controls, modelId: unknownRoute.modelId } });
  assert.equal(submissions, 0, 'Neither selecting nor search Enter submits a surrounding form');
});

test('filtered navigation never commits a removed or hidden option after a catalog refresh', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const changed: string[] = [];
  const props = { value: h3.modelId, capabilities: [h3, unknownRoute, literalRoute], onChange: (id: string) => changed.push(id) };
  const view = render(<ModelPicker {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  const search = screen.getByRole('combobox');
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  view.rerender(<ModelPicker {...props} capabilities={[h3]} />);
  assert.equal(document.getElementById(search.getAttribute('aria-activedescendant')!)?.getAttribute('aria-selected'), 'true');
  fireEvent.change(search, { target: { value: '<script>unmatched</script>' } });
  assert.equal(search.hasAttribute('aria-activedescendant'), false);
  fireEvent.keyDown(search, { key: 'Enter' });
  assert.deepEqual(changed, []);
  assert.equal(document.querySelectorAll('script').length, 0);
});

test('multiple instances keep labels, descriptions and result focus IDs independent', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  render(<><ModelPicker value={h3.modelId} capabilities={[h3]} onChange={() => {}} /><ModelPicker value={unknownRoute.modelId} capabilities={[unknownRoute]} onChange={() => {}} /></>);
  const triggers = screen.getAllByRole('button', { name: 'Model' });
  fireEvent.click(triggers[0]!);
  const firstPanelId = triggers[0]!.getAttribute('aria-controls');
  fireEvent.click(triggers[1]!);
  const secondPanelId = triggers[1]!.getAttribute('aria-controls');
  assert.notEqual(firstPanelId, secondPanelId);
  assert.equal(triggers[0]!.getAttribute('aria-expanded'), 'false');
  const search = screen.getByRole('combobox');
  const active = document.getElementById(search.getAttribute('aria-activedescendant')!);
  assert.ok(active?.textContent?.includes(unknownRoute.name));
  const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, 'No duplicate IDs across pickers');
});

test('empty metadata never implies support while arbitrary supplied frame roles remain literal', async () => {
  const { ModelPicker } = await import('../src/ModelPicker.tsx');
  const model: CapabilityView = { ...unknownRoute, frameRoles: ['unmapped_role'], seedSupported: true };
  render(<ModelPicker value="" capabilities={[model]} onChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  const option = screen.getByRole('option', { name: model.name });
  assert.equal(within(option).getAllByText('Not listed').length, 2);
  assert.ok(within(option).getByText('unmapped_role'));
  assert.ok(within(option).getByText('Seed supported'));
  assert.doesNotMatch(option.textContent!, /Start frame|End frame/);
});
