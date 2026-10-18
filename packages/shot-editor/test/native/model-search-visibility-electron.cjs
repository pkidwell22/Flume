const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const [scratch, evidence] = process.argv.slice(2);
const origin = 'https://model-search-visibility.invalid';
app.setPath('userData', path.join(scratch, 'user'));
app.setPath('sessionData', path.join(scratch, 'session'));
app.setPath('logs', path.join(scratch, 'logs'));
app.setActivationPolicy('accessory'); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let win;
const report = { runtime: process.versions, actualApp: true, liveServices: false, checks: [], metrics: {}, errors: [], requests: [], cleanup: {} };
const pause = (ms = 90) => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
const cdp = (method, args = {}) => win.webContents.debugger.sendCommand(method, args);
const model = '.fl-model-picker__trigger', search = '.fl-model-picker__search';
async function capture(name) {
  assert.equal(win.isVisible(), false); await pause(120);
  const image = await win.webContents.capturePage(undefined, { stayHidden: true });
  assert.equal(image.isEmpty(), false);
  await fs.writeFile(path.join(evidence, name + '.png'), image.toPNG());
}
async function check(name, fn) {
  const entry = { name, passed: false };
  try { await fn(); entry.passed = true; } catch (error) { entry.error = error.message; await capture('failure-' + report.checks.length); }
  report.checks.push(entry);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode === 'Enter' || keyCode === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ', modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await pause();
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
  win.destroy(); assert.equal(win.isDestroyed(), true);
  report.cleanup.closedWindows = (report.cleanup.closedWindows || 0) + 1;
}
async function load(width, query = '', reduced = false) {
  await closeWindow();
  win = new BrowserWindow({ width, height: width === 320 ? 740 : 1000, show: false, focusable: false, webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) report.errors.push(message); });
  await win.loadURL(origin + '/index.html?' + query);
  for (let i = 0; i < 80; i++) { if (await js(`!!document.querySelector(${JSON.stringify(model)})`)) break; await pause(25); }
  assert.equal(await js(`!!document.querySelector(${JSON.stringify(model)})`), true);
  win.webContents.debugger.attach('1.3');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Emulation.setEmulatedMedia', { features: reduced ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [] });
  await js(`window.measurePicker=()=>{
    const p=document.querySelector('.fl-model-picker__panel'),s=document.querySelector('.fl-model-picker__search'),l=document.querySelector('.fl-model-picker__results'),a=s&&document.getElementById(s.getAttribute('aria-activedescendant'));
    const r=e=>e?.getBoundingClientRect().toJSON();
    return {popup:r(p),search:r(s),list:r(l),active:r(a),heading:r(a?.querySelector('strong')),anchor:r(document.querySelector('.fl-model-picker__trigger')),popupScroll:p?.scrollTop,listScroll:l?.scrollTop,listHeight:l?.clientHeight,listFull:l?.scrollHeight,
      activeId:a?.querySelector('.fl-model-picker__literal')?.textContent,selected:[...document.querySelectorAll('[role=option][aria-selected=true] .fl-model-picker__literal')].map(e=>e.textContent),value:document.querySelector('.fl-model-picker__trigger').value,
      focus:document.activeElement?.className,focused:document.activeElement===s,hasFocus:document.hasFocus(),outline:s&&getComputedStyle(s).outlineWidth,focusVisible:s?.matches(':focus-visible'),
      query:s?.value,open:p?.matches(':popover-open'),pageScroll:scrollY,viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth};
  };void 0;`);
  await js(`document.querySelector(${JSON.stringify(model)}).scrollIntoView({block:'center',behavior:'instant'})`); await pause(160);
}
async function open() {
  await js(`window.firstPlacement=null;document.querySelector(${JSON.stringify(model)}).addEventListener('click',()=>requestAnimationFrame(()=>{window.firstPlacement=window.measurePicker()}),{once:true})`);
  await click(model);
}
async function measure(label) { const g = await js('window.measurePicker()'); report.metrics[label] = g; return g; }
function visible(g) {
  assert.equal(g.open, true); assert.equal(g.focused, true); assert.equal(g.hasFocus, true);
  assert.equal(g.focusVisible, true); assert.equal(g.outline, '3px');
  assert.ok(g.search.top - 6 >= g.popup.top + 1 && g.search.bottom + 6 <= g.popup.bottom - 1, 'Focused search and its complete outline stay in the popup scrollport');
  assert.ok(g.search.left - 6 >= g.popup.left + 1 && g.search.right + 6 <= g.popup.right - 1, 'Search outline fits horizontally');
  assert.ok(g.popup.top >= 11 && g.popup.bottom <= g.viewport.height - 11, 'Popup stays bounded');
  assert.equal(g.documentWidth, g.viewport.width);
}
function activeVisible(g) {
  // An oversized item cannot fit in a short list: its identity must remain visible.
  assert.ok(g.list.top >= g.search.bottom && g.list.bottom <= g.popup.bottom, 'Results occupy their own bounded scrollport below search');
  assert.ok(g.heading.top >= g.list.top - 1 && g.heading.bottom <= Math.min(g.list.bottom, g.popup.bottom) + 1, 'Active result name is visible, including oversized options');
}
async function noCommands() {
  assert.deepEqual(await js('window.surfaceFixture.commands'), []);
  assert.deepEqual(await js('window.surfaceFixture.uploads'), []);
}
async function run() {
  await app.whenReady(); assert.equal(app.isPackaged, false);
  const files = new Map([['/index.html',['index.html','text/html']],['/fixture.js',['fixture.js','application/javascript']],['/fixture.css',['fixture.css','text/css']],['/api/media/surface-first',['first.svg','image/svg+xml']],['/api/media/surface-last',['last.svg','image/svg+xml']]]);
  session.defaultSession.setPermissionRequestHandler((_a,_b,done)=>done(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.protocol.handle('https', async request => {
    const url = new URL(request.url), target = files.get(url.pathname);
    if (url.origin !== origin || request.method !== 'GET' || !target) return new Response('Forbidden fixture resource', { status:403 });
    report.requests.push({path:url.pathname,method:request.method});
    return new Response(await fs.readFile(path.join(scratch,target[0])),{headers:{'content-type':target[1]}});
  });
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith(origin+'/')}));
  for (const width of [320,1440]) {
    await check('actual App original first-open '+width, async()=>{
      await load(width); await noCommands(); await open();
      await capture('app-original-first-'+width);
      const g=await measure('app-original-first-'+width), first=await js('window.firstPlacement');
      report.metrics['app-original-first-paint-'+width]=first;
      visible(first);visible(g);activeVisible(g);await noCommands();
      assert.deepEqual(await js('window.surfaceFixture.state().dirtyShotIds'),[]);
    });
    for (const mode of ['component','app']) for (const reduced of [false,true]) {
      const label=mode+'-'+width+(reduced?'-reduced':'');
      await load(width,'long'+(mode==='component'?'&component':''),reduced);
      await check(label+' first-open long selected',async()=>{
        await noCommands();await open();await capture(label+'-first');
        const g=await measure(label+'-first');const first=await js('window.firstPlacement');report.metrics[label+'-first-paint']=first;
        assert.equal(g.activeId,'fixture/route-28');assert.deepEqual(g.selected,['fixture/route-28']);
        visible(first);visible(g);activeVisible(g);await noCommands();
      });
      await check(label+' long navigation and selected/active distinction',async()=>{
        // Continue even after a failed visibility assertion, retaining other outcomes.
        const originScroll=await js('scrollY');
        for(const [keyCode,modifiers,id] of [['Down',[],'fixture/route-29'],['End',['control'],'  fixture/Mixed-ID  '],['Down',[],'fixture/route-0'],['Up',[],'  fixture/Mixed-ID  '],['Home',['control'],'fixture/route-0']]) {
          await key(keyCode,modifiers);const g=await measure(label+'-nav-'+keyCode+'-'+id.trim());
          assert.equal(g.activeId,id);assert.equal(g.value,'fixture/route-28');assert.deepEqual(g.selected,['fixture/route-28']);visible(g);activeVisible(g);assert.equal(g.pageScroll,originScroll,'Navigation never scrolls the editor');
        }
        await capture(label+'-navigation');await noCommands();
        if(mode==='app')assert.deepEqual(await js('window.surfaceFixture.state().dirtyShotIds'),[]);
      });
      await check(label+' manual remembered scroll survives positioning',async()=>{
        await js(`document.querySelector('.fl-model-picker__results').scrollTop=1400`);await pause(220);
        const before=await measure(label+'-remembered-before');assert.ok(Math.abs(before.listScroll-1400)<1);
        await js(`window.dispatchEvent(new Event('resize'))`);await pause(220);
        const after=await measure(label+'-remembered-after');assert.equal(after.listScroll,before.listScroll);visible(after);
        const wheelPoint=await js(`(()=>{const r=document.querySelector('.fl-model-picker__results').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
        win.webContents.sendInputEvent({type:'mouseWheel',...wheelPoint,deltaY:-130,deltaX:0});await pause(220);
        const wheeled=await measure(label+'-wheel');assert.notEqual(wheeled.listScroll,after.listScroll,'Native wheel scrolls the results');visible(wheeled);
        await js(`window.dispatchEvent(new Event('resize'))`);await pause(220);
        assert.equal((await measure(label+'-wheel-remembered')).listScroll,wheeled.listScroll);
        await js(`const list=document.querySelector('.fl-model-picker__results');list.scrollTop=list.scrollHeight;`);await pause(220);
        const bottom=await measure(label+'-manual-bottom');
        await js(`window.dispatchEvent(new Event('resize'))`);await pause(220);
        assert.equal((await measure(label+'-manual-bottom-resize')).listScroll,bottom.listScroll,'Manual bottom scroll is remembered too');
        // Bottom is sensitive to the hook's temporary unconstrained measurement.
        await key('End',['control']);const end=await measure(label+'-end-before-resize');
        await js(`window.dispatchEvent(new Event('resize'))`);await pause(220);
        const resized=await measure(label+'-end-after-resize');assert.equal(resized.listScroll,end.listScroll);visible(resized);activeVisible(resized);
      });
      await check(label+' Escape reopen filtering clear and Tab',async()=>{
        await key('Escape');assert.equal(await js(`document.activeElement===document.querySelector(${JSON.stringify(model)})`),true);
        await open();let g=await measure(label+'-reopen');visible(g);activeVisible(g);assert.equal(g.activeId,'fixture/route-28');assert.equal(g.query,'');
        for(const code of ['Down','Up']) {await key('Escape');await key(code);visible(await measure(label+'-arrow-open-'+code));}
        await key('Home');await key('End');assert.equal((await measure(label+'-text-keys')).activeId,'fixture/route-28','Plain Home/End stay text editing keys');
        await win.webContents.insertText('not-in-catalog');await pause(180);g=await measure(label+'-empty');visible(g);assert.equal(await js('document.querySelectorAll("[role=option]").length'),0);
        await key('Enter');assert.equal(await js(`!!document.querySelector(${JSON.stringify(search)})`),true);
        await capture(label+'-empty');await click('.fl-model-picker__search-row button');
        g=await measure(label+'-clear');visible(g);activeVisible(g);assert.equal(g.query,'');assert.equal(g.value,'fixture/route-28');
        await win.webContents.insertText('fixture/route-12');await pause(180);g=await measure(label+'-filtered');visible(g);activeVisible(g);assert.equal(g.activeId,'fixture/route-12');assert.equal(g.value,'fixture/route-28');await capture(label+'-filtered');
        await key('Tab');assert.equal(await js('document.activeElement.textContent'),'Clear search');
        await key('Tab');assert.equal(await js('!!document.querySelector(".fl-model-picker__panel")'),false);
        assert.equal(await js(`document.activeElement===document.querySelector(${JSON.stringify(model)})`),false);
        await noCommands();if(mode==='app')assert.deepEqual(await js('window.surfaceFixture.state().dirtyShotIds'),[]);
      });
      await check(label+' Enter literal model intent preserves draft and frames',async()=>{
        await key('Escape');await js(`document.querySelector(${JSON.stringify(model)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause();await open();
        const retained=await js(`({prompt:document.querySelector('textarea')?.value,fields:[...document.querySelectorAll('.fl-generation-settings input')].map(e=>[e.type,e.value,e.checked]),frames:[...document.querySelectorAll('.fl-shot-editor__frames img')].map(e=>e.src)})`);
        await key('End',['control']);await key('Enter');
        assert.equal(await js(`document.querySelector(${JSON.stringify(model)}).value`),'  fixture/Mixed-ID  ');
        assert.equal(await js(`document.activeElement===document.querySelector(${JSON.stringify(model)})`),true);
        assert.equal(await js('!!document.querySelector(".fl-model-picker__panel")'),false);
        assert.deepEqual(await js(`({prompt:document.querySelector('textarea')?.value,fields:[...document.querySelectorAll('.fl-generation-settings input')].map(e=>[e.type,e.value,e.checked]),frames:[...document.querySelectorAll('.fl-shot-editor__frames img')].map(e=>e.src)})`),retained);
        if(mode==='app')assert.deepEqual(await js('window.surfaceFixture.state().dirtyShotIds'),['surface-shot']);
        else assert.deepEqual(await js('window.surfaceFixture.changes'),['  fixture/Mixed-ID  ']);
        report.metrics[label+'-retained-draft']=retained;
        if(mode==='app')assert.equal(retained.frames.length,2,'Both fixture frame roles must actually be present');
        await noCommands();await open();await key('Enter');await noCommands();
        if(mode==='component')assert.equal(await js('window.surfaceFixture.changes.length'),1,'Reselecting is a no-op');
      });
      if(reduced)await check(label+' reduced motion',async()=>{
        await open();visible(await measure(label+'-motion'));
        assert.equal(await js(`getComputedStyle(document.querySelector('.fl-model-picker__option')).transitionDuration`),'0s');
        assert.equal(await js(`getComputedStyle(document.querySelector('.fl-model-picker__panel')).animationName`),'none');
      });
    }
  }
  // Characterization only: synthetic DOM composition flags are not OS IME proof.
  report.inheritedIme={};
  for(const mode of ['component','app']) {
    await load(320,'long'+(mode==='component'?'&component':''));await open();
    const original=await js('window.measurePicker().activeId');
    await js(`for(const key of ['ArrowDown','Enter','Escape'])document.querySelector('.fl-model-picker__search').dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,isComposing:true}));`);await pause();
    const composing=await js('window.measurePicker()');
    await js(`document.querySelector('.fl-model-picker__search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:229,bubbles:true}));`);await pause();
    const fallbackEscapeClosed=await js(`!document.querySelector('.fl-model-picker__panel')`);
    await key('Escape');
    await js(`document.querySelector('.fl-model-picker__trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',isComposing:true,bubbles:true}));`);await pause();
    report.inheritedIme[mode]={syntheticOnly:true,composingNavigationIgnored:composing.activeId===original,composingEnterIgnored:composing.value==='fixture/route-28',composingEscapeIgnored:composing.open===true,keyCode229EscapeCloses:fallbackEscapeClosed,composingTriggerArrowOpens:await js(`!!document.querySelector('.fl-model-picker__panel')`)};
    await noCommands();
  }
  report.success=report.checks.length>0&&report.checks.every(c=>c.passed)&&report.errors.length===0;
}
void run().catch(error=>{report.fatal={message:error.message,stack:error.stack};report.success=false;}).finally(async()=>{
  await closeWindow();report.cleanup.emulationCleared=true;report.cleanup.hiddenThroughout=true;
  session.defaultSession.protocol.unhandle('https');
  await fs.writeFile(path.join(evidence,'native-report.json'),JSON.stringify(report,null,2)+'\n');app.exit(report.success?0:1);
});
