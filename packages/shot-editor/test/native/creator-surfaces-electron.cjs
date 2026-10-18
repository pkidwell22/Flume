const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const [scratch, evidence] = process.argv.slice(2);
const origin = 'https://creator-surfaces.invalid';
app.setPath('userData', path.join(scratch, 'user'));
app.setPath('sessionData', path.join(scratch, 'session'));
app.setPath('logs', path.join(scratch, 'logs'));
app.setActivationPolicy('accessory');
app.disableHardwareAcceleration();
// The runner owns lifetime; replacing the last hidden fixture must not quit.
app.on('window-all-closed', () => {});
let win;
const report = { runtime: process.versions, actualApp: true, liveServices: false, checks: [], metrics: {}, cascade: {}, errors: [], requests: [], cleanup: {} };
const pause = (ms = 90) => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
const cdp = (method, args = {}) => win.webContents.debugger.sendCommand(method, args);
const selectors = { prompt: '.fl-prompt-composer textarea', model: '.fl-model-picker__trigger', settings: '.fl-generation-settings__field input:not([type="checkbox"])', audio: '.fl-generation-settings__audio', clear: '.fl-generation-settings__seed-entry button', directions: '.fl-prompt-composer__toolbar button', help: '.fl-model-picker__help', hint: '.fl-prompt-composer__toolbar p' };
const modelPanel = '.fl-model-picker__panel', guidancePanel = '.fl-prompt-composer__directions';
async function check(name, fn) {
  const entry = { name, passed: false };
  try { await fn(); entry.passed = true; } catch (error) { entry.error = error.message; }
  report.checks.push(entry);
}
async function capture(name) {
  assert.equal(win.isVisible(), false);
  await pause(160);
  const image = await win.webContents.capturePage(undefined, { stayHidden: true });
  assert.equal(image.isEmpty(), false);
  await fs.writeFile(path.join(evidence, name + '.png'), image.toPNG());
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode === 'Enter' || keyCode === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ', modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause();
}
async function scrollTo(selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
  await pause();
}
async function click(selector) {
  const point = await js(`(() => {const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);return {x,y,hit:el.contains(document.elementFromPoint(x,y))};})()`);
  assert.equal(point.hit, true, 'Native pointer hits ' + selector);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await pause();
}
async function closeWindow() {
  if (!win || win.isDestroyed()) return;
  assert.equal(win.isVisible(), false);
  if (win.webContents.debugger.isAttached()) {
    await cdp('Emulation.setEmulatedMedia', { features: [] });
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: false });
    win.webContents.debugger.detach();
  }
  win.destroy();
  assert.equal(win.isDestroyed(), true);
  report.cleanup.closedWindows = (report.cleanup.closedWindows || 0) + 1;
}
async function load(width, disabled = false) {
  // Fresh renderer per fixture: actual App input guards can legitimately block
  // navigation after a search (APP-EDIT-01). Never weaken its production guard.
  await closeWindow();
  win = new BrowserWindow({ width, height: width === 320 ? 740 : 1000, show: false, focusable: false, webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) report.errors.push(message); });
  await win.loadURL(origin + '/index.html' + (disabled ? '?disabled' : ''));
  for (let i = 0; i < 80; i++) { if (await js('!!document.querySelector(".fl-prompt-composer textarea")')) break; await pause(25); }
  assert.equal(await js('!!document.querySelector(".fl-prompt-composer textarea")'), true, 'Actual creator mounted');
  await pause(150);
  win.webContents.debugger.attach('1.3');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('DOM.enable'); await cdp('CSS.enable');
}
async function metrics(extra = {}) {
  return js(`(() => {
    const props=['backgroundColor','color','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderBottomColor','borderTopColor','borderBottomStyle','borderRadius','fontSize','fontFamily','lineHeight','minHeight','opacity','outlineWidth','outlineStyle','outlineColor','outlineOffset','cursor','resize'];
    const targets=${JSON.stringify({ ...selectors, ...extra })}, out={};
    for(const [key,sel] of Object.entries(targets)){const el=document.querySelector(sel);if(!el)continue;const s=getComputedStyle(el);out[key]={...Object.fromEntries(props.map(p=>[p,s[p]])),rect:el.getBoundingClientRect().toJSON(),disabled:el.matches(':disabled')};}
    out.tokens={};for(const name of ['well','control','surface','ink','muted','border','rule','focus','bg','danger']){const e=document.createElement('span');e.style.backgroundColor='var(--fl-'+name+')';document.querySelector('.fl-theme').append(e);out.tokens[name]=getComputedStyle(e).backgroundColor;e.remove();}
    out.width={viewport:innerWidth,document:document.documentElement.scrollWidth};
    return out;
  })()`);
}
async function cascade(label, targetMap) {
  const { root } = await cdp('DOM.getDocument', { depth: 0 });
  const rows = {};
  for (const [name, selector] of Object.entries(targetMap)) {
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector });
    const data = await cdp('CSS.getMatchedStylesForNode', { nodeId });
    rows[name] = data.matchedCSSRules.filter(m => m.rule.origin === 'regular').map(m => ({
      selector: m.rule.selectorList.text,
      selectors: m.rule.selectorList.selectors,
      matchingSelectors: m.matchingSelectors,
      source: m.rule.sourceURL,
      range: m.rule.style.range,
      declarations: m.rule.style.cssProperties.filter(p => !p.disabled && p.parsedOk !== false).map(p => ({ name: p.name, value: p.value, important: !!p.important, implicit: !!p.implicit, range: p.range })),
    }));
  }
  report.cascade[label] = rows;
}
async function geometry(trigger, panel) {
  return js(`(() => {const t=document.querySelector(${JSON.stringify(trigger)}),p=document.querySelector(${JSON.stringify(panel)}),r=e=>e.getBoundingClientRect().toJSON();return {anchor:r(t),popup:p?r(p):null,open:!!p?.matches(':popover-open'),position:p?getComputedStyle(p).position:null,viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,popupScrollWidth:p?.scrollWidth,popupClientWidth:p?.clientWidth,footer:document.querySelector('.fl-shot-editor__footer').getBoundingClientRect().toJSON()};})()`);
}
function bounded(g) {
  assert.ok(g.open, 'Native popover is open'); assert.equal(g.position, 'fixed');
  assert.ok(g.popup.left >= 11 && g.popup.top >= 11 && g.popup.right <= g.viewport.width - 11 && g.popup.bottom <= g.viewport.height - 11, 'Popup fits viewport gutters');
  assert.ok(g.popupScrollWidth <= g.popupClientWidth + 1, 'Popup content not horizontally clipped');
  assert.ok(g.documentWidth <= g.viewport.width, 'No page overflow');
  assert.ok(Math.min(Math.abs(g.popup.top - g.anchor.bottom - 8), Math.abs(g.anchor.top - g.popup.bottom - 8)) < 2, 'Popup remains attached across content changes');
}
async function contrast(label) {
  const data = await js(`(() => {
    const rgb=s=>s.match(/[\\d.]+/g).map(Number), lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    const rows=[];
    for(const e of document.querySelectorAll('.fl-shot-editor *')){
      if(!e.getClientRects().length||e.matches(':disabled')||(!e.matches('input,textarea')&&!Array.from(e.childNodes).some(n=>n.nodeType===3&&n.textContent.trim())))continue;
      const s=getComputedStyle(e);let a=e,b;while(a){b=rgb(getComputedStyle(a).backgroundColor);if(b.length===3||b[3]===1)break;a=a.parentElement;}
      if(!a)continue;
      const fg=lum(rgb(s.color)),bg=lum(b),ratio=(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
      rows.push({tag:e.tagName,cls:e.className,text:(e.textContent||e.getAttribute('aria-label')||'').slice(0,70),color:s.color,background:getComputedStyle(a).backgroundColor,fontSize:s.fontSize,ratio});
    }return rows;
  })()`);
  report.metrics[label + '-contrast'] = data;
  assert.ok(data.length > 0);
  assert.deepEqual(data.filter(r => r.ratio < 4.5), [], 'Enabled text remains readable on the winning surface');
}
async function run() {
  await app.whenReady(); assert.equal(app.isPackaged, false);
  const files = new Map([['/index.html',['index.html','text/html']],['/fixture.js',['fixture.js','application/javascript']],['/fixture.css',['fixture.css','text/css']],['/api/media/surface-first',['first.svg','image/svg+xml']],['/api/media/surface-last',['last.svg','image/svg+xml']]]);
  session.defaultSession.setPermissionRequestHandler((_a, _b, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // Intercept a synthetic HTTPS origin locally: no socket or HTTP server exists.
  session.defaultSession.protocol.handle('https', async request => {
    const url = new URL(request.url), target = files.get(url.pathname);
    if (url.origin !== origin || request.method !== 'GET' || !target) return new Response('Forbidden fixture resource', { status: 403 });
    report.requests.push({ path: url.pathname, method: request.method });
    return new Response(await fs.readFile(path.join(scratch, target[0])), { headers: { 'content-type': target[1] } });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') }));
  for (const width of [1440, 320]) {
    await load(width);
    await scrollTo('.fl-prompt-composer');
    const closed = await metrics(); report.metrics['closed-' + width] = closed;
    await cascade('closed-' + width, selectors);
    await capture('composer-' + width);
    await check('surface hierarchy ' + width, async () => {
      assert.equal(closed.prompt.backgroundColor, closed.tokens.well, 'Prompt must use the inset well, not the enclosing surface');
      assert.deepEqual(['Top','Right','Left'].map(side => closed.prompt['border' + side + 'Width']), ['0px','0px','0px'], 'Prompt must not restore a four-sided frame');
      assert.equal(closed.prompt.borderBottomWidth, '1px'); assert.equal(closed.prompt.borderBottomColor, closed.tokens.border);
      assert.equal(closed.prompt.fontSize, '14px'); assert.equal(closed.prompt.lineHeight, '21px'); assert.equal(closed.prompt.minHeight, '96px'); assert.equal(closed.prompt.resize, 'vertical');
      for (const name of ['settings','model','audio','clear','directions']) assert.equal(closed[name].backgroundColor, closed.tokens.control, name + ' uses the compact control tier');
      assert.equal(closed.settings.borderTopWidth, '0px'); assert.equal(closed.settings.borderBottomColor, closed.tokens.border);
      for (const name of ['model','audio','clear','directions']) assert.equal(closed[name].borderTopColor, closed.tokens.rule, name + ' has a quiet perimeter');
      for (const name of ['help','hint']) assert.ok(parseFloat(closed[name].fontSize) >= 12, 'Do not shrink supporting copy below 12px');
    });
    await check('references and responsive geometry ' + width, async () => {
      await scrollTo('.fl-shot-editor__frames'); await capture('references-' + width);
      const images = await js(`Array.from(document.querySelectorAll('.fl-shot-editor__image img')).map(e=>({natural:[e.naturalWidth,e.naturalHeight],box:e.getBoundingClientRect().toJSON(),parent:e.parentElement.getBoundingClientRect().toJSON(),fit:getComputedStyle(e).objectFit}))`);
      report.metrics['references-' + width] = images;
      assert.deepEqual(images.map(i => i.natural), [[400,1200],[1600,400]]);
      for (const image of images) { assert.equal(image.fit,'contain'); assert.ok(image.box.height <= 52 && image.box.width <= 80); assert.ok(image.box.top >= image.parent.top && image.box.bottom <= image.parent.bottom); }
      assert.equal(closed.width.document, closed.width.viewport);
      const controls = await js(`Array.from(document.querySelectorAll('.fl-prompt-composer textarea,.fl-generation-settings input,.fl-generation-settings button,.fl-generation-settings__audio,.fl-model-picker__trigger')).map(e=>({cls:e.className,r:e.getBoundingClientRect().toJSON(),sw:e.scrollWidth,cw:e.clientWidth}))`);
      report.metrics['controls-' + width] = controls;
      assert.ok(controls.every(e => e.r.left >= 0 && e.r.right <= width && (e.sw <= e.cw + 1)), 'Real controls fit without hidden overflow');
    });
    await check('enabled contrast ' + width, () => contrast('closed-' + width));
    for (const [kind, trigger, panel] of [['model',selectors.model,modelPanel],['guidance',selectors.directions,guidancePanel]]) {
      await check(kind + ' open/filter surface and anchor ' + width, async () => {
        await key('Escape'); await scrollTo(trigger);
        const before = await js(`document.querySelector('.fl-shot-editor__footer').getBoundingClientRect().toJSON()`);
        await click(trigger);
        const g = await geometry(trigger,panel); report.metrics[kind + '-open-' + width] = g; bounded(g);
        assert.deepEqual(g.footer, before, 'Opening does not move the footer');
        await cascade(kind + '-open-' + width, { panel, ...(kind === 'model' ? { search: '.fl-model-picker__search' } : { choice: '.fl-prompt-composer__choices button' }) });
        await capture(kind + '-open-' + width);
        assert.equal(await js(`document.querySelector(${JSON.stringify(panel)}).matches(':popover-open')`), true, 'Saved capture contains an open popup');
        await contrast(kind + '-open-' + width);
        const m = await metrics({ panel, ...(kind === 'model' ? { search: '.fl-model-picker__search' } : { choice: '.fl-prompt-composer__choices button' }) });
        report.metrics[kind + '-surfaces-' + width] = m;
        assert.equal(m.panel.backgroundColor,m.tokens.surface); assert.equal(m.panel.borderTopColor,m.tokens.border,'Floating boundaries remain explicit');
        if (kind === 'model') {
          await win.webContents.insertText('no-such-surface-model'); await pause(180);
          const filtered = await geometry(trigger,panel); report.metrics['filtered-' + width] = filtered; bounded(filtered);
          await capture('model-filtered-' + width);
          assert.equal(await js(`document.querySelectorAll('[role="option"]').length`),0);
          report.metrics['filter-controller-state-' + width] = await js('window.surfaceFixture.state()'); // APP-EDIT-01 is out of this CSS lane.
          await click('.fl-model-picker__search-row button');
          bounded(await geometry(trigger,panel));
          assert.equal(m.search.backgroundColor,m.tokens.well,'Search is a recessed input within the floating surface');
          assert.equal(m.search.borderTopWidth,'0px'); assert.equal(m.search.borderBottomColor,m.tokens.border);
        } else {
          assert.equal(m.choice.backgroundColor,m.tokens.control,'Guidance choices sit above the floating surface');
          assert.equal(m.choice.borderTopColor,m.tokens.rule);
        }
      });
      await key('Escape');
    }
    await check('native focus and disabled save ' + width, async () => {
      await load(width); await scrollTo(selectors.prompt);
      await click(selectors.prompt); await key('Tab'); await key('Tab', ['shift']);
      const focus = await js(`(()=>{const e=document.activeElement,s=getComputedStyle(e);return {tag:e.tagName,visible:e.matches(':focus-visible'),hasFocus:document.hasFocus(),outline:s.outlineWidth,offset:s.outlineOffset,color:s.outlineColor};})()`);
      report.metrics['focus-' + width] = focus; assert.equal(focus.tag,'TEXTAREA'); assert.equal(focus.visible,true); assert.equal(focus.hasFocus,true); assert.equal(focus.outline,'3px'); assert.equal(focus.color,closed.tokens.focus);
      await capture('prompt-focus-' + width);
      await scrollTo('.fl-shot-editor__footer'); await capture('controls-' + width);
      assert.equal(await js(`document.querySelector('.fl-shot-editor__footer-actions button').disabled`),true,'Unchanged draft stays unsaveable');
      assert.deepEqual(await js('window.surfaceFixture.commands'),[],'No commands were sent');
    });
  }
  await check('explicit component disabled surfaces', async () => {
    await load(320,true); const m = await metrics(); report.metrics.disabled = m; await capture('disabled-320');
    for (const name of ['prompt','model','directions']) { assert.equal(m[name].disabled,true); assert.equal(m[name].opacity,'1','Disabled copy is not faded into unreadability'); assert.equal(m[name].color,m.tokens.muted); assert.equal(m[name].backgroundColor,m.tokens.bg); assert.equal(m[name].cursor,'not-allowed'); }
  });
  await check('forced colors retain boundaries and focus', async () => {
    await load(320); await cdp('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
    await scrollTo(selectors.prompt); await click(selectors.prompt); await key('Tab'); await key('Tab',['shift']);
    const m=await metrics(); report.metrics.forcedColors=m; await capture('forced-colors-320');
    assert.equal(m.prompt.outlineWidth,'3px'); assert.equal(m.prompt.outlineStyle,'solid'); assert.equal(m.prompt.borderBottomWidth,'1px');
    assert.notEqual(m.prompt.outlineColor,m.prompt.backgroundColor,'Focus survives forced colors');
    assert.equal(m.model.borderTopWidth,'1px');
    await cdp('Emulation.setEmulatedMedia',{features:[]});
  });
  report.success=report.checks.length>0&&report.checks.every(c=>c.passed)&&report.errors.length===0;
}
void run().catch(error => { report.fatal={message:error.message,stack:error.stack}; report.success=false; }).finally(async () => {
  if(win&&!win.isDestroyed()) {
    report.cleanup.hiddenThroughout=!win.isVisible();
    try { if(win.webContents.debugger.isAttached()) { await cdp('Emulation.setEmulatedMedia',{features:[]}); await cdp('Emulation.setFocusEmulationEnabled',{enabled:false}); report.cleanup.emulationCleared=true; win.webContents.debugger.detach(); } } catch(error) {report.cleanup.error=error.message;}
    win.destroy(); report.cleanup.windowDestroyed=win.isDestroyed();
  }
  session.defaultSession.protocol.unhandle('https');
  await fs.writeFile(path.join(evidence,'native-report.json'),JSON.stringify(report,null,2)+'\n');
  app.exit(report.success?0:1);
});
