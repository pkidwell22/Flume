import {test} from 'node:test';
import assert from 'node:assert/strict';
import {render, defaults, act, deferred} from './dom';
import {shot, take} from './fixtures';

for (const revision of ['revision', 'selectionRevision'] as const) {
  for (const order of ['callback-first', 'readback-first'] as const) {
    test(`superseding unselected ${revision} retires the focus claim immediately (${order})`, async () => {
      const pending = deferred<void>();
      const requests: unknown[] = [];
      const props = defaults({onSelect: request => {requests.push(request);return pending.promise;}});
      const ui = await render(props);
      const reset: (() => void)[] = [];
      const live: {target: EventTarget; type: string; listener: EventListenerOrEventListenerObject | null; capture: boolean}[] = [];
      const removed: string[] = [];
      try {
        const player = ui.all('video')[0];
        await ui.event(player, 'loadeddata');
        await ui.event(player, 'playing');
        await ui.click(ui.button('Inspect take')!);
        const select = ui.button('Select take')!;
        const document = ui.dom.window.document;
        const capture = (options?: boolean | AddEventListenerOptions | EventListenerOptions) => typeof options === 'boolean' ? options : !!options?.capture;
        for (const target of [select, document] as EventTarget[]) {
          const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
          target.addEventListener = (type, listener, options) => {
            if ((target === select && type === 'blur') || (target === document && ['focusin', 'pointerdown'].includes(type))) {
              live.push({target, type, listener, capture: capture(options)});
            }
            add(type, listener, options);
          };
          target.removeEventListener = (type, listener, options) => {
            const index = live.findIndex(item => item.target === target && item.type === type && item.listener === listener && item.capture === capture(options));
            if (index >= 0) {live.splice(index, 1);removed.push(type);}
            remove(type, listener, options);
          };
          reset.push(() => {target.addEventListener = add;target.removeEventListener = remove;});
        }
        select.focus();
        let restorations = 0;
        const focus = select.focus.bind(select);
        select.focus = options => {if (options?.preventScroll) restorations++;focus(options);};
        reset.push(() => {select.focus = focus;});
        await ui.click(select);
        assert.equal(select.disabled, true);
        assert.deepEqual(live.map(item => [item.type, item.capture]).sort(), [['blur', false], ['focusin', true], ['pointerdown', true]]);
        // jsdom retains focus on disabled buttons; the unchanged Electron oracle
        // proves actual disabled blur, BODY focus, and zero stale focus attempts.
        const expectedFocus = document.activeElement;
        assert.ok(expectedFocus === select);
        assert.equal(live.length, 3, 'an active request keeps its claim');
        if (order === 'callback-first') {
          await act(async () => pending.resolve());
          assert.equal(live.length, 3, 'callback completion is not authoritative readback');
        }
        const superseded = {...props, shot: {...shot, [revision]: shot[revision] + 1}};
        await ui.update(superseded);
        assert.equal(live.length, 0, 'retire at the superseding unselected readback, even before callback completion');
        assert.deepEqual(removed.sort(), ['blur', 'focusin', 'pointerdown'], 'remove all exact target/type/listener/capture tuples');
        assert.equal(restorations, 0, 'superseding readback must not restore');
        assert.equal(select.disabled, true, 'no obsolete inspection authority');
        if (order === 'readback-first') await act(async () => pending.resolve());
        assert.equal(ui.button('Inspect take')!.disabled, false, 'fresh inspection is available after completion');
        assert.equal(select.disabled, true, 'retired inspection cannot authorize a new selection');
        assert.equal(live.length, 0, 'callback cannot rearm the retired claim');
        await ui.update({...superseded, shot: {...superseded.shot, selectedTakeId: take.id, selectionRevision: superseded.shot.selectionRevision + 1}});
        assert.ok(document.activeElement === expectedFocus, 'later readback leaves retained focus alone');
        assert.equal(restorations, 0, 'zero stale scripted focus attempts');
        assert.equal(live.length, 0);
        assert.ok(ui.all('video')[0] === player, 'preserve the player');
        assert.ok(ui.button('Selected') === select, 'preserve the selection control');
        assert.deepEqual(requests, [{projectId: shot.projectId, shotId: shot.id, takeId: take.id, inspectionId: 'inspection-a', expectedRevision: shot.revision, expectedSelectionRevision: shot.selectionRevision}]);
      } finally {
        await ui.close();
        for (const restore of reset) restore();
      }
    });
  }
}
