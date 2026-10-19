import {test} from 'node:test';
import assert from 'node:assert/strict';
import {render, defaults, act, deferred} from './dom';
import {shot, take} from './fixtures';

for (const order of ['callback-first', 'readback-first'] as const) {
  test(`selection preserves a newer details focus (${order})`, async () => {
    const pending = deferred<void>();
    const props = defaults({onSelect: () => pending.promise});
    const ui = await render(props);
    try {
      const player = ui.all('video')[0];
      await ui.event(player, 'loadeddata');
      await ui.event(player, 'playing');
      await ui.click(ui.button('Inspect take')!);
      const select = ui.button('Select take')!;
      select.focus();
      await ui.click(select);
      await ui.update({...props, busy: true});
      const details = ui.all('summary')[0] as HTMLElement;
      details.focus();
      assert.ok(ui.dom.window.document.activeElement === details);
      if (order === 'callback-first') await act(async () => pending.resolve());
      const readback = {...props, shot: {...shot, selectedTakeId: take.id, selectionRevision: 3}};
      await ui.update({...readback, busy: true});
      if (order === 'readback-first') await act(async () => pending.resolve());
      assert.ok(ui.dom.window.document.activeElement === details, 'busy readback preserves deliberate focus');
      await ui.update(readback);
      assert.ok(ui.dom.window.document.activeElement === details, 'completion must not steal deliberate focus');
      assert.ok(ui.all('video')[0] === player, 'focus correction must not replace the native player');
    } finally { await ui.close(); }
  });
}

for (const order of ['callback-first', 'readback-first'] as const) {
  for (const loss of ['retained', 'before-disabled'] as const) {
    test(`selection never restores focus it did not disable (${loss}, ${order})`, async () => {
      const pending = deferred<void>();
      let select: HTMLButtonElement;
      const props = defaults({onSelect: () => {
        // The callback runs before React commits the disabled state.
        if (loss === 'before-disabled') select.blur();
        return pending.promise;
      }});
      const ui = await render(props);
      try {
        await ui.event(ui.all('video')[0], 'loadeddata');
        await ui.event(ui.all('video')[0], 'playing');
        await ui.click(ui.button('Inspect take')!);
        select = ui.button('Select take')!;
        select.focus();
        let restorations = 0;
        const focus = select.focus.bind(select);
        select.focus = options => { restorations++; focus(options); };
        await ui.click(select);
        assert.equal(select.disabled, true);
        // jsdom retains disabled focus; actual loss/restoration is tested natively.
        const expected = loss === 'retained' ? select : ui.dom.window.document.body;
        assert.ok(ui.dom.window.document.activeElement === expected);
        if (order === 'callback-first') await act(async () => pending.resolve());
        await ui.update({...props, shot: {...shot, selectedTakeId: take.id, selectionRevision: 3}});
        if (order === 'readback-first') await act(async () => pending.resolve());
        assert.ok(ui.dom.window.document.activeElement === expected, 'only disability-caused loss permits restoration');
        assert.equal(restorations, 0, 'no restoration without a disabled-control blur');
      } finally { await ui.close(); }
    });
  }
}

for (const end of ['readback', 'new-focus', 'pointer', 'unmount'] as const) {
  test(`selection focus observation is disposed on ${end}`, async () => {
    const pending = deferred<void>();
    const props = defaults({onSelect: () => pending.promise});
    const ui = await render(props);
    try {
      await ui.event(ui.all('video')[0], 'loadeddata');
      await ui.event(ui.all('video')[0], 'playing');
      await ui.click(ui.button('Inspect take')!);
      const select = ui.button('Select take')!;
      const document = ui.dom.window.document;
      const listeners = new Set<unknown>();
      const add = document.addEventListener.bind(document);
      const remove = document.removeEventListener.bind(document);
      document.addEventListener = ((type: string, listener: EventListener, options: boolean) => {
        if (type === 'focusin' || type === 'pointerdown') listeners.add(listener);
        add(type, listener, options);
      }) as typeof document.addEventListener;
      document.removeEventListener = ((type: string, listener: EventListener, options: boolean) => {
        if (type === 'focusin' || type === 'pointerdown') listeners.delete(listener);
        remove(type, listener, options);
      }) as typeof document.removeEventListener;
      select.focus();
      await ui.click(select);
      assert.ok(listeners.size > 0, 'observe focus only for a focused initiating control');
      if (end === 'new-focus') {
        const details = ui.all('summary')[0] as HTMLElement;
        details.focus();details.blur();
      } else if (end === 'pointer') {
        await ui.event(document.body, 'pointerdown');
      } else if (end === 'unmount') {
        await ui.update({...props, shot: null});
      }
      const expected = document.activeElement;
      let restorations = 0;
      const focus = select.focus.bind(select);
      select.focus = options => { restorations++; focus(options); };
      await act(async () => pending.resolve());
      await ui.update({...props, shot: {...shot, selectedTakeId: take.id, selectionRevision: 3}});
      assert.equal(listeners.size, 0, 'do not retain document listeners after cancellation or restoration');
      assert.ok(document.activeElement === expected, 'canceled or unmounted requests never reclaim focus');
      assert.equal(restorations, 0);
    } finally { await ui.close(); }
  });
}
