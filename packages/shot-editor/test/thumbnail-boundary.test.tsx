import './setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ShotEditor } from '../src/index.ts';
import type { AssetView, DraftFrameReport, ShotEditorProps } from '../src/types.ts';
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

/** Every <img> the reference strip actually put in the DOM. */
function stripImages(): HTMLImageElement[] {
  return Array.from(document.querySelectorAll('.fl-shot-editor__image img'));
}

/** The start-frame asset keeps the fixture binding (`start`) so the strip resolves it. */
function boundStart(overrides: Partial<AssetView> = {}): AssetView {
  return { ...assets[0]!, ...overrides };
}

test('owned reference media still renders, including a same-origin absolute URL with a query', () => {
  const absolute = { ...assets[1]!, mediaUrl: 'http://localhost/api/media/end?rev=2' };
  render(<ShotEditor {...props({ assets: [assets[0]!, absolute] })} />);
  assert.equal(
    screen.getByRole('img', { name: 'Start frame: cup-start.png' }).getAttribute('src'),
    '/api/media/start',
  );
  assert.equal(
    screen.getByRole('img', { name: 'End frame: cup-end.png' }).getAttribute('src'),
    '/api/media/end?rev=2',
  );
  assert.equal(stripImages().length, 2);
});

test('a saved same-origin URL outside /api/media/ is never requested, and its binding survives', () => {
  const artwork = boundStart({ filename: 'alpine-forest-wide.webp', mediaUrl: '/art/alpine-forest-wide.webp' });
  const saves: unknown[] = [];
  const reports: DraftFrameReport[] = [];
  render(
    <ShotEditor
      {...props({
        assets: [artwork],
        onSave: async (input) => {
          saves.push(input);
          return { revision: 4 };
        },
        onDraftChange: (report) => reports.push(report),
      })}
    />,
  );

  assert.equal(stripImages().length, 0, 'the refused URL never becomes an <img src>');
  assert.equal(document.querySelector('img[src="/art/alpine-forest-wide.webp"]'), null);
  assert.ok(
    screen.getByRole('img', { name: 'Reference preview unavailable: alpine-forest-wide.webp' }),
    'the strip says the preview is unavailable instead of showing media',
  );
  assert.match(screen.getByText('Preview unavailable · not shown').textContent!, /not shown/);
  assert.ok(screen.getAllByText('alpine-forest-wide.webp').length > 0, 'the filename is still named');
  assert.equal(
    (screen.getByLabelText('Start frame image') as HTMLSelectElement).value,
    'start',
    'the saved binding is not cleared',
  );
  assert.equal(
    (screen.getByRole('status').textContent ?? '').includes('Saved revision 3'),
    true,
    'the saved state is unchanged',
  );
  assert.equal(saves.length, 0, 'rendering a refused thumbnail writes nothing');
  assert.equal(reports.at(-1)?.first?.assetId, 'start', 'the draft report keeps the bound identity');
  assert.equal(reports.at(-1)?.first?.filename, 'alpine-forest-wide.webp');
});

const refusedUrls: Array<[string, string]> = [
  ['an external https URL with an owned-looking path', 'https://cdn.example.com/api/media/start'],
  ['a protocol-relative external URL', '//cdn.example.com/api/media/start'],
  ['a data URL', 'data:image/png;base64,AAAA'],
  ['a javascript URL', 'javascript:alert(1)'],
  ['a blob URL', 'blob:http://localhost/6f6d'],
  ['a malformed URL', 'http://[::1'],
  ['a credentialed same-origin URL', 'http://user:pass@localhost/api/media/start'],
  ['a traversing path', '/api/media/../secret'],
  ['an encoded traversal path', '/api/media/%2e%2e/start'],
  ['another same-origin API route', '/api/commands'],
  ['an empty media URL', ''],
];

for (const [label, mediaUrl] of refusedUrls) {
  test(`refuses ${label} in the reference strip without touching the binding`, () => {
    const saves: unknown[] = [];
    render(
      <ShotEditor
        {...props({
          assets: [boundStart({ filename: 'bound.png', mediaUrl })],
          onSave: async (input) => {
            saves.push(input);
            return { revision: 4 };
          },
        })}
      />,
    );
    assert.equal(stripImages().length, 0, 'no <img> element is created');
    assert.ok(
      screen.getByRole('img', { name: 'Reference preview unavailable: bound.png' }),
      'the unavailable placeholder is honest and labelled',
    );
    assert.equal(
      (screen.getByLabelText('Start frame image') as HTMLSelectElement).value,
      'start',
      'the binding survives a refused URL',
    );
    assert.equal(saves.length, 0);
  });
}

test('a legacy asset with no recorded mediaUrl is reported unavailable instead of crashing', () => {
  const legacy = boundStart({ filename: 'legacy.png', mediaUrl: undefined as unknown as string });
  render(<ShotEditor {...props({ assets: [legacy] })} />);
  assert.equal(stripImages().length, 0);
  assert.ok(screen.getByRole('img', { name: 'Reference preview unavailable: legacy.png' }));
  assert.equal((screen.getByLabelText('Start frame image') as HTMLSelectElement).value, 'start');
});

test('a missing asset keeps the existing unavailable-image wording and no thumbnail', () => {
  render(<ShotEditor {...props({ assets: [assets[0]!] })} />);
  assert.equal(stripImages().length, 1, 'only the owned start frame renders a thumbnail');
  assert.match(screen.getByText('Unavailable image: end', { selector: 'option' }).textContent!, /end/);
});

test('a refused thumbnail does not make the editor dirty or block an explicit save', async () => {
  const saves: Array<{ patch: { bindings: unknown } }> = [];
  render(
    <ShotEditor
      {...props({
        assets: [boundStart({ filename: 'bound.png', mediaUrl: '/art/bound.webp' })],
        onSave: async (input) => {
          saves.push(input as { patch: { bindings: unknown } });
          return { revision: 4 };
        },
      })}
    />,
  );
  assert.equal(
    (screen.getByRole('status').textContent ?? '').includes('Saved revision 3'),
    true,
    'a render-time refusal is not an edit',
  );
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Explicit edit' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0]!.patch.bindings, {
    firstFrameAssetId: 'start',
    lastFrameAssetId: 'end',
  });
});
