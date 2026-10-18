const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL, fileURLToPath } = require('node:url');
const [scratch, evidence, filter = ''] = process.argv.slice(2);
app.setPath('userData', path.join(scratch, 'user')); app.setPath('sessionData', path.join(scratch, 'session')); app.setPath('logs', path.join(scratch, 'logs'));
app.setActivationPolicy('accessory'); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const report = { liveApp: false, runtime: process.versions, checks: [], errors: [], requests: [], cleanup: {} };
let win;
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
const js = source => win.webContents.executeJavaScript(source, true);
const selectors = {
  hook: ['#hook-trigger', '#hook-panel'],
  model: ['.fl-model-picker__trigger', '.fl-model-picker__panel'],
  guidance: ['.fl-prompt-composer__toolbar button', '.fl-prompt-composer__directions'],
};
async function reset(mode = 'hook') {
  await js(`window.fixture.reset(${JSON.stringify(mode)});for(const id of ['clip','outer','stage']){const e=document.getElementById(id);e.style.cssText='';e.className=''}document.querySelector('#scroller').scrollTop=0;document.querySelector('#clip').scrollTop=0`);
  win.setSize(1100, 1000); await pause();
}
async function click(selector) {
  const p = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`);
  assert.ok(p.hit, 'real pointer hits ' + selector);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await pause();
}
async function geometry(mode = 'hook') {
  const [trigger, panel] = selectors[mode];
  return js(`(()=>{const a=document.querySelector(${JSON.stringify(trigger)}),p=document.querySelector(${JSON.stringify(panel)}),c=document.querySelector('#clip');return{anchor:a.getBoundingClientRect().toJSON(),popup:p?.getBoundingClientRect().toJSON(),side:p?.dataset.side,topLayer:p?.matches(':popover-open'),clip:{...c.getBoundingClientRect().toJSON(),clientLeft:c.clientLeft,clientTop:c.clientTop,clientWidth:c.clientWidth,clientHeight:c.clientHeight,offsetWidth:c.offsetWidth,offsetHeight:c.offsetHeight},viewport:{width:innerWidth,height:innerHeight},state:window.fixture.state()}})()`);
}
function bounded(g) {
  assert.ok(g.topLayer && g.popup, 'popup remains in the native top layer');
  assert.ok(g.popup.left >= 11 && g.popup.top >= 11 && g.popup.right <= g.viewport.width - 11 && g.popup.bottom <= g.viewport.height - 11, JSON.stringify(g));
  const gap = g.side === 'above' ? g.anchor.top - g.popup.bottom : g.popup.top - g.anchor.bottom;
  assert.ok(Math.abs(gap - 8) < 1, 'popup follows the viewport anchor with an 8px gap: ' + gap);
}
async function capture(name) {
  assert.equal(win.isVisible(), false);
  const image = await win.webContents.capturePage(undefined, { stayHidden: true });
  assert.ok(!image.isEmpty()); await fs.writeFile(path.join(evidence, name + '.png'), image.toPNG());
}
async function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  const item = { name, passed: false };
  try { item.details = await fn(item); item.passed = true; }
  catch (e) { item.error = { message: e.message, stack: e.stack }; await capture('failure-' + report.checks.length); }
  report.checks.push(item);
}
// The visibility oracle is native hit-testing, NOT a second copy of the hook's
// client-metric conversion. Scanning both center-lines catches narrow slivers.
async function anchorHit() {
  return js(`(()=>{const e=document.querySelector('#hook-trigger'),r=e.getBoundingClientRect();for(let x=r.left+0.5;x<r.right;x+=0.5)if(e.contains(document.elementFromPoint(x,(r.top+r.bottom)/2)))return true;for(let y=r.top+0.5;y<r.bottom;y+=0.5)if(e.contains(document.elementFromPoint((r.left+r.right)/2,y)))return true;return false})()`);
}
async function run() {
  await app.whenReady(); assert.equal(app.isPackaged, false);
  session.defaultSession.setPermissionCheckHandler(() => false); session.defaultSession.setPermissionRequestHandler((_a, _b, cb) => cb(false));
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => { let allowed = false; try { allowed = d.url.startsWith('file:') && fileURLToPath(d.url).startsWith(scratch + path.sep); } catch {} report.requests.push({ url: allowed ? path.basename(fileURLToPath(d.url)) : 'blocked-nonfixture-request', allowed }); cb({ cancel: !allowed }); });
  win = new BrowserWindow({ width: 1100, height: 1000, show: false, focusable: false, webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) report.errors.push(message); });
  await win.loadURL(pathToFileURL(path.join(scratch, 'index.html')).href); await pause(); assert.ok(await js('!!window.fixture'));
  win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  for (const mode of ['hook', 'model', 'guidance']) {
    for (const [sx, sy] of [[1, 1], [0.5, 0.5], [2, 2], [0.75, 1.25]]) {
      await check(`${mode} first frame and clipping resize scale=${sx},${sy} translated`, async item => {
        await reset(mode);
        const [t, p] = selectors[mode];
        await js(`document.querySelector('#clip').style.transform='translate(17px,19px) scale(${sx},${sy})';window.first=null;document.querySelector(${JSON.stringify(t)}).addEventListener('click',()=>requestAnimationFrame(()=>{const a=document.querySelector(${JSON.stringify(t)}),p=document.querySelector(${JSON.stringify(p)});window.first={anchor:a.getBoundingClientRect().toJSON(),popup:p?.getBoundingClientRect().toJSON(),topLayer:p?.matches(':popover-open'),side:p?.dataset.side,viewport:{width:innerWidth,height:innerHeight}}}),{once:true})`);
        await click(t);
        const before = await geometry(mode), first = await js('window.first');
        item.details = { before, first }; bounded(before); bounded(first);
        if (sx === 0.5) await capture(mode + '-scaled-first-open');
        await js(`(()=>{const c=document.querySelector('#clip'),a=document.querySelector(${JSON.stringify(t)}).getBoundingClientRect(),r=c.getBoundingClientRect();c.style.height=((a.top-r.top)/${sy}-10)+'px'})()`);
        await pause(180); const after = await geometry(mode); item.details.after = after;
        assert.ok(after.anchor.top >= after.clip.bottom, 'native anchor is wholly below the clip');
        assert.equal(!!after.popup, false, 'fully clipped anchor dismisses');
        assert.deepEqual([after.state.model, after.state.prompt], ['paired', '  Literal prompt.  ']);
        if (mode === 'model' && sx === 0.5) await capture('model-scaled-dismissed');
        return item.details;
      });
    }
  }
  for (const [sx, sy] of [[1, 1], [0.5, 0.5], [2, 1.5], [0.75, 1.25]]) {
    for (const scrollbars of ['hidden', 'ltr', 'rtl']) {
      const gutters = scrollbars !== 'hidden';
      await check(`hook border and ${gutters ? scrollbars + ' native scrollbars' : 'hidden overflow'} edges scale=${sx},${sy}`, async item => {
        const edges = []; item.details = edges;
        for (const edge of ['left', 'right', 'top', 'bottom']) {
          await reset();
          await js(`(()=>{const c=document.querySelector('#clip');c.style.cssText='width:300px;height:260px;border-style:solid;border-width:16px 12px 24px 20px;transform:translate(25px,20px) scale(${sx},${sy});overflow:${gutters ? 'scroll' : 'hidden'};direction:${scrollbars === 'rtl' ? 'rtl' : 'ltr'}';c.className=${JSON.stringify(gutters ? 'gutters' : '')};c.scrollLeft=${scrollbars === 'rtl' ? '-c.scrollWidth' : '0'};const a=document.querySelector('#hook-trigger');a.textContent='X';a.style.cssText='width:40px;height:30px;white-space:nowrap;overflow:hidden';window.place=(sliver)=>{a.style.left=(${JSON.stringify(edge)}==='left'?-40+sliver:${JSON.stringify(edge)}==='right'?c.clientWidth-sliver:60)+'px';a.style.top=(${JSON.stringify(edge)}==='top'?-30+sliver:${JSON.stringify(edge)}==='bottom'?c.clientHeight-sliver:80)+'px'};window.place(4)})()`);
          const metrics = await geometry();
          if (gutters) {
            assert.ok(metrics.clip.offsetWidth - metrics.clip.clientWidth - 32 > 0, 'real vertical scrollbar gutter is present');
            assert.ok(metrics.clip.offsetHeight - metrics.clip.clientHeight - 40 > 0, 'real horizontal scrollbar gutter is present');
            assert.equal(metrics.clip.clientLeft, scrollbars === 'rtl' ? 38 : 20, 'native left scrollbar contributes to clientLeft only in RTL');
          }
          assert.equal(await anchorHit(), true, `${edge}: native hit test sees the 4px layout sliver`);
          await js('window.hook.open(true)'); await pause(); const partial = await geometry();
          assert.equal(!!partial.popup, true, `${edge}: partially visible anchor must survive`);
          await js("window.place(0);window.dispatchEvent(new Event('resize'))"); await pause(); const contact = await geometry();
          edges.push({ edge, partial, contact });
          assert.equal(await anchorHit(), false, `${edge}: native hit test sees no anchor at exact contact`);
          assert.equal(!!contact.popup, false, `${edge}: exact contact is wholly clipped`);
        }
        return edges;
      });
    }
  }
  await check('nested nonuniform scaling follows real scroll and window resize then dismisses', async item => {
    await reset();
    await js("document.querySelector('#outer').style.transform='translate(18px,20px) scale(1.5,0.5)';document.querySelector('#clip').style.cssText='transform:scale(0.5,2);overflow:auto;border:12px solid';window.hook.open(true)");
    await pause(); const before = await geometry(); bounded(before);
    await js("document.querySelector('#clip').scrollTop=40"); await pause(); const scrolled = await geometry(); bounded(scrolled);
    assert.ok(Math.abs(scrolled.anchor.top - before.anchor.top + 40) < 1, 'native scroll includes cumulative scaleY=1');
    win.setSize(850, 800); await pause(160); const resized = await geometry(); bounded(resized);
    await js("document.querySelector('#clip').scrollTop=200"); await pause(); const clipped = await geometry();
    item.details = { before, scrolled, resized, clipped };
    assert.equal(!!clipped.popup, false); assert.equal(await anchorHit(), false);
    assert.deepEqual(clipped.state.dismissals, [0]); return item.details;
  });
  await check('overflow clip on one axis does not invent clipping on the visible axis', async () => {
    const results = [];
    for (const axis of ['x', 'y']) {
      await reset();
      await js(`document.querySelector('#clip').style.cssText='transform:scale(0.5);overflow-x:${axis === 'x' ? 'clip' : 'visible'};overflow-y:${axis === 'y' ? 'clip' : 'visible'}'`);
      await js(`document.querySelector('#hook-trigger').style.${axis === 'x' ? 'top' : 'left'}='430px';window.hook.open(true)`);
      await pause(); const visibleAxis = await geometry(); assert.equal(!!visibleAxis.popup, true);
      await js(`document.querySelector('#hook-trigger').style.${axis === 'x' ? 'left' : 'top'}='430px';window.dispatchEvent(new Event('resize'))`);
      await pause(); const clippedAxis = await geometry(); assert.equal(!!clippedAxis.popup, false);
      results.push({ axis, visibleAxis, clippedAxis });
    }
    return results;
  });
  await check('zero-sized clipping ancestor dismisses without nonfinite geometry', async () => {
    await reset(); await js('window.hook.open(true)'); await pause(); bounded(await geometry());
    await js("document.querySelector('#clip').style.width='0px'"); await pause(); const result = await geometry();
    assert.equal(result.clip.offsetWidth, 0); assert.equal(!!result.popup, false); assert.deepEqual(result.state.dismissals, [0]); return result;
  });
  report.success = report.checks.length > 0 && report.checks.every(c => c.passed) && report.errors.length === 0;
}
void run().catch(e => { report.fatal = { message: e.message, stack: e.stack }; report.success = false; }).finally(async () => {
  if (win && !win.isDestroyed()) {
    report.cleanup.hiddenThroughout = !win.isVisible();
    try { if (win.webContents.debugger.isAttached()) { await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }); report.cleanup.focusEmulationCleared = true; win.webContents.debugger.detach(); report.cleanup.debuggerDetached = true; } }
    catch (e) { report.cleanup.error = e.message; }
    win.destroy(); report.cleanup.windowDestroyed = win.isDestroyed();
  }
  await fs.writeFile(path.join(evidence, 'native-report.json'), JSON.stringify(report, null, 2) + '\n'); app.exit(report.success ? 0 : 1);
});
