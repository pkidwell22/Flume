import './setup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelPicker } from '../src/ModelPicker.tsx';
import type { CapabilityView } from '../src/types.ts';

// jsdom does not lay out/scroll. Native first-paint and clipping assertions live
// in test/native/model-search-visibility.mjs; here fixed boxes isolate the
// scrolling contract, using the real component and its keyboard handlers.
test('active navigation scrolls only results, aligns oversized names and preserves manual scroll on rerender', () => {
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  const intoView = HTMLElement.prototype.scrollIntoView;
  let ancestorScrollRequests = 0;
  HTMLElement.prototype.scrollIntoView = function () { ancestorScrollRequests++; };
  HTMLElement.prototype.getBoundingClientRect = function () {
    const list = document.querySelector('.fl-model-picker__results') as HTMLElement | null;
    let top = 100, height = 120;
    if (this.getAttribute('role') === 'option') {
      const index = [...this.parentElement!.children].indexOf(this);
      top += index * 200 - (list?.scrollTop ?? 0); height = 200;
    }
    return { x: 0, y: top, top, bottom: top + height, left: 0, right: 296, width: 296, height, toJSON() {} };
  };
  const catalog: CapabilityView[] = Array.from({ length: 6 }, (_, i) => ({ modelId: `literal/${i}`, name: `Model ${i}`, durations: [5], resolutions: ['2K'], frameRoles: ['first_frame'], seedSupported: false, availability: 'blocked', blocker: 'Supplied route remains draft intent.' }));
  const changed: string[] = [];
  const props = { value: 'literal/4', capabilities: catalog, onChange: (id: string) => changed.push(id) };
  try {
    const view = render(<ModelPicker {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    const search = screen.getByRole('combobox');
    const list = screen.getByRole('listbox');
    assert.equal(ancestorScrollRequests, 0, 'Active option must not request ancestor/page scrolling');
    assert.equal(list.scrollTop, 800, 'Opening reveals the long selected option from its heading');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    assert.equal(list.scrollTop, 600, 'Backward navigation reveals the heading rather than the oversized tail');
    assert.equal(screen.getByRole('option', { name: 'Model 4' }).getAttribute('aria-selected'), 'true');
    assert.equal(screen.getByRole('option', { name: 'Model 3' }).getAttribute('data-active'), 'true');
    assert.deepEqual(changed, []);
    list.scrollTop = 430;
    view.rerender(<ModelPicker {...props} capabilities={[...catalog]} />);
    assert.equal(list.scrollTop, 430, 'Unchanged active identity does not erase manually remembered scroll');
    fireEvent.keyDown(search, { key: 'End', ctrlKey: true });
    assert.equal(list.scrollTop, 1000);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    assert.equal(list.scrollTop, 0, 'Wrapping to an oversized first item exposes its heading');
    fireEvent.change(search, { target: { value: 'Model 2' } });
    assert.equal(list.scrollTop, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    assert.ok(document.activeElement === search);
    fireEvent.keyDown(search, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    assert.equal(screen.getByRole('listbox').scrollTop, 800, 'Reopen reestablishes controlled selection, not the last explored choice');
    assert.deepEqual(changed, []);
  } finally {
    cleanup(); HTMLElement.prototype.getBoundingClientRect = bounds;
    if (intoView) HTMLElement.prototype.scrollIntoView = intoView;
    else delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  }
});
