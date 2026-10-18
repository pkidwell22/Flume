import './setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ShotEditor } from '../src/index.ts';
import type {
  ShotEditorProps,
  SaveShotInput,
  UploadReferenceInput,
  PrepareShotInput,
} from '../src/types.ts';
import { assets, capabilities, shot } from './fixtures.ts';

afterEach(cleanup);
function props(overrides: Partial<ShotEditorProps> = {}): ShotEditorProps {
  return {
    shot,
    assets,
    capabilities,
    onSave: async () => ({ revision: 4 }),
    onUpload: async () => assets[0]!,
    onPrepare: async () => {},
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('renders actual distinct reference images and explicitly saves the literal edited prompt', async () => {
  const saved: SaveShotInput[] = [];
  render(
    <ShotEditor
      {...props({
        onSave: async (input) => {
          saved.push(input);
          return { revision: 4 };
        },
      })}
    />,
  );
  assert.equal(
    screen.getByRole('img', { name: 'Start frame: cup-start.png' }).getAttribute('src'),
    '/api/media/start',
  );
  assert.equal(
    screen.getByRole('img', { name: 'End frame: cup-end.png' }).getAttribute('src'),
    '/api/media/end',
  );
  const literal = '  Stay still.\n\nNo <drift>.  ';
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: literal } });
  assert.equal(saved.length, 0);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.patch.prompt, literal);
  assert.equal(saved[0]!.patch.controls.seed, 0);
  assert.equal(saved[0]!.patch.controls.generateAudio, false);
  assert.deepEqual(saved[0]!.patch.bindings, {
    firstFrameAssetId: 'start',
    lastFrameAssetId: 'end',
  });
});

test('keeps B during held POST and C during held GET, with the accepted base revision', async () => {
  const post = deferred<{ revision: number }>();
  const saves: SaveShotInput[] = [];
  const dirty: boolean[] = [];
  const initial = props({
    onSave: (input) => {
      saves.push(input);
      return saves.length === 1 ? post.promise : Promise.resolve({ revision: 5 });
    },
    onDirtyChange: (value) => dirty.push(value),
  });
  const view = render(<ShotEditor {...initial} />);
  const prompt = () => screen.getByLabelText('Prompt') as HTMLTextAreaElement;
  fireEvent.change(prompt(), { target: { value: 'A submitted' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  fireEvent.change(prompt(), { target: { value: 'B during POST' } });
  await act(async () => post.resolve({ revision: 4 }));
  assert.equal(prompt().value, 'B during POST', 'POST success must not restore A');
  fireEvent.change(prompt(), { target: { value: 'C during GET' } });
  view.rerender(<ShotEditor {...initial} shot={{ ...shot, revision: 4, prompt: 'A submitted' }} />);
  assert.equal(prompt().value, 'C during GET', 'GET completion must not restore A');
  assert.equal(dirty.at(-1), true);
  assert.match(screen.getByRole('status').textContent!, /Unsaved changes/);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  assert.equal(saves[1]!.expectedRevision, 4);
  assert.equal(saves[1]!.patch.prompt, 'C during GET');
});

test('passive newer revisions update a clean buffer but conflict with a dirty buffer until explicit reconciliation', async () => {
  const saved: SaveShotInput[] = [];
  const initial = props({
    onSave: async (input) => {
      saved.push(input);
      return { revision: 6 };
    },
  });
  const view = render(<ShotEditor {...initial} />);
  const prompt = () => screen.getByLabelText('Prompt') as HTMLTextAreaElement;
  view.rerender(
    <ShotEditor {...initial} shot={{ ...shot, revision: 4, prompt: 'New saved text' }} />,
  );
  assert.equal(prompt().value, 'New saved text');
  fireEvent.change(prompt(), { target: { value: 'My unsaved text' } });
  view.rerender(
    <ShotEditor {...initial} shot={{ ...shot, revision: 5, prompt: 'A different edit' }} />,
  );
  assert.equal(prompt().value, 'My unsaved text');
  assert.match(screen.getByRole('alert').textContent!, /changed elsewhere/);
  assert.equal(
    (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Keep my edits against revision 5' }));
  assert.equal(prompt().value, 'My unsaved text');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  assert.equal(saved[0]!.expectedRevision, 5);
  view.rerender(<ShotEditor {...initial} shot={{ ...shot, revision: 3 }} />);
  assert.equal(prompt().value, 'My unsaved text', 'An old GET must not rewind an accepted save');
});

test('model changes explain incompatibilities without erasing settings or demoting the end frame', async () => {
  const saved: SaveShotInput[] = [];
  render(
    <ShotEditor
      {...props({
        onSave: async (input) => {
          saved.push(input);
          return { revision: 4 };
        },
      })}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  fireEvent.click(screen.getByRole('option', { name: 'Start-only model' }));
  assert.equal((screen.getByLabelText('Seed (optional)') as HTMLInputElement).value, '0');
  assert.equal((screen.getByLabelText('Duration (seconds)') as HTMLInputElement).value, '5');
  assert.equal((screen.getByLabelText('Resolution') as HTMLInputElement).value, '2K');
  assert.equal((screen.getByLabelText('End frame image') as HTMLSelectElement).value, 'end');
  assert.match(
    screen.getByRole('region', { name: 'Model compatibility' }).textContent!,
    /Account privacy settings block this model/,
  );
  assert.match(
    screen.getByRole('region', { name: 'Model compatibility' }).textContent!,
    /does not support an end frame/,
  );
  assert.equal(
    (screen.getByRole('button', { name: 'Review generation' }) as HTMLButtonElement).disabled,
    true,
  );
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  assert.equal(saved[0]!.patch.controls.modelId, 'start-only');
  assert.equal(saved[0]!.patch.bindings.lastFrameAssetId, 'end');
  assert.equal(saved[0]!.patch.controls.seed, 0);
});

test('review requires saved compatible intent and calls prepare exactly once with the base revision', async () => {
  const prepares: PrepareShotInput[] = [];
  const prepared = deferred<void>();
  const initial = props({
    onPrepare: (input) => {
      prepares.push(input);
      return prepared.promise;
    },
  });
  const view = render(<ShotEditor {...initial} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review generation' }));
  assert.deepEqual(prepares, [{ projectId: shot.projectId, shotId: shot.id, expectedRevision: 3 }]);
  assert.equal(
    (screen.getByRole('button', { name: 'Preparing review…' }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.change(screen.getByLabelText('Prompt'), {
    target: { value: 'Edited during preparation' },
  });
  await act(async () => prepared.resolve());
  assert.equal(
    (screen.getByLabelText('Prompt') as HTMLTextAreaElement).value,
    'Edited during preparation',
  );
  assert.equal(
    (screen.getByRole('button', { name: 'Review generation' }) as HTMLButtonElement).disabled,
    true,
  );
  view.rerender(<ShotEditor {...initial} busy />);
  assert.equal(
    (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal((screen.getByLabelText('Prompt') as HTMLTextAreaElement).disabled, false);
});

test('file selection imports an explicit end-frame role and only changes the local binding', async () => {
  const uploaded: UploadReferenceInput[] = [];
  const saved: SaveShotInput[] = [];
  const result = deferred<(typeof assets)[number]>();
  const newAsset = {
    ...assets[1]!,
    id: 'new-end',
    filename: 'new-end.png',
    mediaUrl: '/api/media/new-end',
  };
  render(
    <ShotEditor
      {...props({
        onUpload: (input) => {
          uploaded.push(input);
          return result.promise;
        },
        onSave: async (input) => {
          saved.push(input);
          return { revision: 4 };
        },
      })}
    />,
  );
  const file = new File(['image bytes'], 'new-end.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('Upload end frame'), { target: { files: [file] } });
  assert.equal(uploaded.length, 1);
  assert.deepEqual(uploaded[0], {
    projectId: shot.projectId,
    shotId: shot.id,
    expectedRevision: 3,
    role: 'last_frame',
    file,
  });
  fireEvent.change(screen.getByLabelText('Prompt'), {
    target: { value: 'Keep this newer prompt' },
  });
  await act(async () => result.resolve(newAsset));
  assert.equal((screen.getByLabelText('End frame image') as HTMLSelectElement).value, 'new-end');
  assert.equal((screen.getByLabelText('Start frame image') as HTMLSelectElement).value, 'start');
  assert.equal(
    (screen.getByLabelText('Prompt') as HTMLTextAreaElement).value,
    'Keep this newer prompt',
  );
  assert.equal(saved.length, 0);
  assert.equal(
    screen.getByRole('img', { name: 'End frame: new-end.png' }).getAttribute('src'),
    '/api/media/new-end',
  );
});

test('clearing an uploading reference prevents its late completion from attaching stale intent', async () => {
  const result = deferred<(typeof assets)[number]>();
  render(<ShotEditor {...props({ onUpload: () => result.promise })} />);
  fireEvent.change(screen.getByLabelText('Upload end frame'), {
    target: { files: [new File(['bytes'], 'late.png', { type: 'image/png' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Clear end frame' }));
  await act(async () => result.resolve({ ...assets[1]!, id: 'late', filename: 'late.png' }));
  assert.equal((screen.getByLabelText('End frame image') as HTMLSelectElement).value, '');
  assert.match(
    screen.getByText(/Imported late.png but did not attach it/).textContent!,
    /reference changed/,
  );
});

test('stale save errors preserve edits and require a fetched latest revision before rebasing', async () => {
  const initial = props({
    onSave: async () => {
      throw { code: 'revision_conflict', message: 'Shot changed', currentRevision: 8 };
    },
  });
  const view = render(<ShotEditor {...initial} />);
  fireEvent.change(screen.getByLabelText('Prompt'), {
    target: { value: 'Keep my conflict buffer' },
  });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  assert.equal(
    (screen.getByLabelText('Prompt') as HTMLTextAreaElement).value,
    'Keep my conflict buffer',
  );
  assert.equal(
    (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    true,
  );
  assert.match(screen.getByRole('alert').textContent!, /revision 8/);
  assert.equal(screen.queryByRole('button', { name: /Keep my edits against revision/ }), null);
  view.rerender(
    <ShotEditor {...initial} shot={{ ...shot, revision: 8, prompt: 'Remote revision' }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Use latest saved shot' }));
  assert.equal((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value, 'Remote revision');
});

test('blank numeric input stays blank instead of becoming zero; an explicit zero is preserved', async () => {
  const saved: SaveShotInput[] = [];
  render(
    <ShotEditor
      {...props({
        onSave: async (input) => {
          saved.push(input);
          return { revision: 4 };
        },
      })}
    />,
  );
  fireEvent.change(screen.getByLabelText('Duration (seconds)'), { target: { value: '' } });
  assert.equal(
    (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(
    (screen.getByLabelText('Duration (seconds)') as HTMLInputElement).getAttribute('aria-invalid'),
    'true',
  );
  fireEvent.change(screen.getByLabelText('Duration (seconds)'), { target: { value: '0' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  assert.equal(saved[0]!.patch.controls.durationSeconds, 0);
});

test('missing bound media stays visibly bound instead of appearing silently cleared', () => {
  render(<ShotEditor {...props({ assets: [assets[0]!] })} />);
  assert.equal((screen.getByLabelText('End frame image') as HTMLSelectElement).value, 'end');
  assert.match(screen.getByText('Unavailable image: end', { selector: 'option' }).textContent!, /end/);
  assert.equal(
    (screen.getByRole('button', { name: 'Review generation' }) as HTMLButtonElement).disabled,
    false,
  );
});

test('rejects non-image file selection before importing without dropping the existing frame', async () => {
  let calls = 0;
  render(
    <ShotEditor
      {...props({
        onUpload: async () => {
          calls++;
          return assets[0]!;
        },
      })}
    />,
  );
  await act(async () =>
    fireEvent.change(screen.getByLabelText('Upload start frame'), {
      target: { files: [new File(['pdf'], 'paper.pdf', { type: 'application/pdf' })] },
    }),
  );
  assert.equal(calls, 0);
  assert.equal((screen.getByLabelText('Start frame image') as HTMLSelectElement).value, 'start');
  assert.match(screen.getByText(/Choose a PNG/).textContent!, /WebP/);
});

test('model changes during an import invalidate binding intent even when the model is changed back', async () => {
  const result = deferred<(typeof assets)[number]>();
  render(<ShotEditor {...props({ onUpload: () => result.promise })} />);
  fireEvent.change(screen.getByLabelText('Upload end frame'), {
    target: { files: [new File(['bytes'], 'late.png', { type: 'image/png' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  fireEvent.click(screen.getByRole('option', { name: 'Start-only model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  fireEvent.click(screen.getByRole('option', { name: 'Paired-frame model' }));
  await act(async () => result.resolve({ ...assets[1]!, id: 'late-model' }));
  assert.equal((screen.getByLabelText('End frame image') as HTMLSelectElement).value, 'end');
});

test('out-of-order imports attach only the newest explicit intent for each independent role', async () => {
  const first = deferred<(typeof assets)[number]>();
  const second = deferred<(typeof assets)[number]>();
  const start = deferred<(typeof assets)[number]>();
  let count = 0;
  render(
    <ShotEditor
      {...props({
        onUpload: (input) =>
          input.role === 'first_frame'
            ? start.promise
            : ++count === 1
              ? first.promise
              : second.promise,
      })}
    />,
  );
  const choose = (name: string) =>
    fireEvent.change(screen.getByLabelText(name), {
      target: { files: [new File(['bytes'], 'new.png', { type: 'image/png' })] },
    });
  choose('Upload end frame');
  choose('Upload end frame');
  choose('Upload start frame');
  await act(async () => second.resolve({ ...assets[1]!, id: 'end-newest' }));
  await act(async () => first.resolve({ ...assets[1]!, id: 'end-obsolete' }));
  await act(async () => start.resolve({ ...assets[0]!, id: 'start-new' }));
  assert.equal((screen.getByLabelText('End frame image') as HTMLSelectElement).value, 'end-newest');
  assert.equal(
    (screen.getByLabelText('Start frame image') as HTMLSelectElement).value,
    'start-new',
  );
});

test('late completion from a different shot cannot attach to the newly opened shot', async () => {
  const result = deferred<(typeof assets)[number]>();
  const initial = props({ onUpload: () => result.promise });
  const view = render(<ShotEditor {...initial} />);
  fireEvent.change(screen.getByLabelText('Upload end frame'), {
    target: { files: [new File(['bytes'], 'late.png', { type: 'image/png' })] },
  });
  view.rerender(
    <ShotEditor
      {...initial}
      shot={{
        ...shot,
        id: 'shot-2',
        prompt: 'Second shot',
        bindings: { firstFrameAssetId: null, lastFrameAssetId: null },
      }}
    />,
  );
  await act(async () => result.resolve({ ...assets[1]!, id: 'late-other-shot' }));
  assert.equal((screen.getByLabelText('End frame image') as HTMLSelectElement).value, '');
  assert.equal((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value, 'Second shot');
});

test('unknown catalog availability is reviewable without hiding blockers or changing editable fields', async () => {
  const initial = props({
    capabilities: [{ ...capabilities[0]!, availability: 'unknown', blocker: null }],
  });
  render(<ShotEditor {...initial} />);
  assert.equal(
    (screen.getByRole('button', { name: 'Review generation' }) as HTMLButtonElement).disabled,
    false,
  );
  assert.match(
    screen.getByRole('region', { name: 'Model compatibility' }).textContent!,
    /not confirmed/,
  );
  fireEvent.change(screen.getByLabelText('Prompt'), {
    target: { value: 'Save this draft anyway' },
  });
  assert.equal(
    (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    false,
  );
});

test('busy state disables side-effect controls without disabling keyboard-editable buffers', () => {
  render(<ShotEditor {...props({ busy: true })} />);
  for (const name of ['Upload start frame', 'Upload end frame'])
    assert.equal((screen.getByLabelText(name) as HTMLInputElement).disabled, true);
  for (const name of ['Save changes', 'Review generation'])
    assert.equal((screen.getByRole('button', { name }) as HTMLButtonElement).disabled, true);
  for (const name of [
    'Shot',
    'Prompt',
    'Model',
    'Duration (seconds)',
    'Resolution',
    'Aspect ratio',
    'Seed (optional)',
    'Generate audio',
    'Start frame image',
    'End frame image',
  ]) {
    const control = screen.getByLabelText(name) as HTMLInputElement;
    assert.equal(control.disabled, false, name);
    control.focus();
    assert.equal(document.activeElement, control, `${name} accepts keyboard focus`);
  }
});

test('a rejected import or a wrong-project result never clears the original binding', async () => {
  const upload = deferred<(typeof assets)[number]>();
  const initial = props({ onUpload: () => upload.promise });
  const view = render(<ShotEditor {...initial} />);
  const selectFile = () =>
    fireEvent.change(screen.getByLabelText('Upload end frame'), {
      target: { files: [new File(['bytes'], 'new.png', { type: 'image/png' })] },
    });
  selectFile();
  await act(async () => upload.reject(new Error('Image cannot be decoded')));
  assert.match(screen.getByText('Image cannot be decoded').textContent!, /decoded/);
  assert.equal((screen.getByLabelText('End frame image') as HTMLSelectElement).value, 'end');
  view.rerender(
    <ShotEditor
      {...initial}
      onUpload={async () => ({ ...assets[1]!, id: 'foreign', projectId: 'other-project' })}
    />,
  );
  await act(async () => selectFile());
  assert.equal((screen.getByLabelText('End frame image') as HTMLSelectElement).value, 'end');
  assert.match(screen.getByText(/not an owned image/).textContent!, /this project/);
});

test('empty workspace offers a concrete action without issuing side effects', () => {
  render(<ShotEditor {...props({ shot: null })} />);
  assert.ok(screen.getByRole('heading', { name: 'Choose a shot' }));
  assert.equal(screen.queryByLabelText('Prompt'), null);
});
