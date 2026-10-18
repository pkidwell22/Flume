const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const [scratch, evidence] = process.argv.slice(2);
const origin = 'https://reference-disclosure.invalid';
app.setPath('userData', path.join(scratch, 'user'));
app.setPath('sessionData', path.join(scratch, 'session'));
app.setPath('logs', path.join(scratch, 'logs'));
app.setActivationPolicy('accessory'); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let win;
const report = { runtime: process.versions, actualApp: true, checks: [], metrics: {}, errors: [], requests: [], cleanup: {}, limitations: ['Hidden offscreen Chromium, not personal browser or live provider.', 'No OS file dialog. Native select popup geometry is not captured by page screenshots.'] };
const pause = (ms = 90) => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
const cdp = (method, args = {}) => win.webContents.debugger.sendCommand(method, args);
const summary = role => `summary[aria-label="${role} frame reference"]`;
const select = role => `[id$="-${role === 'Start' ? 'first' : 'last'}_frame-asset"]`;
const closeButton = role => `${summary(role)} ~ .fl-shot-editor__frame-controls .fl-shot-editor__frame-actions button:last-child`;
const isOpen = role => js(`document.querySelector(${JSON.stringify(summary(role))}).parentElement.open`);
const state = () => js('window.referenceFixture.state()');
const bindings = () => js(`Array.from(document.querySelectorAll('.fl-shot-editor__reference select')).map(e=>e.value)`);
async function check(name, fn) {
  const row = { name, passed: false }; try { await fn(); row.passed = true; } catch (error) { row.error = error.message; }
  report.checks.push(row);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode === 'Enter' || keyCode === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ', modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await pause();
}
async function focus(selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});document.querySelector(${JSON.stringify(selector)}).focus()`); await pause();
}
async function click(selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`); await pause();
  const point = await js(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);return {x,y,hit:e.contains(document.elementFromPoint(x,y))};})()`);
  assert.equal(point.hit, true, 'Native pointer hits '+selector);
  for (const type of ['mouseMove','mouseDown','mouseUp']) win.webContents.sendInputEvent({ type, x:point.x,y:point.y,button:'left',clickCount:1 });
  await pause();
}
async function capture(name) {
  assert.equal(win.isVisible(), false); await pause(120);
  const image = await win.webContents.capturePage(undefined, { stayHidden: true }); assert.equal(image.isEmpty(), false);
  await fs.writeFile(path.join(evidence, name+'.png'), image.toPNG());
}
async function closeWindow() {
  if (!win || win.isDestroyed()) return;
  assert.equal(win.isVisible(), false);
  if (win.webContents.debugger.isAttached()) {
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: false });
    report.cleanup.focusEmulationRemoved = true; win.webContents.debugger.detach();
  }
  win.destroy(); assert.equal(win.isDestroyed(), true);
  report.cleanup.closedWindows = (report.cleanup.closedWindows || 0) + 1;
}
async function load(width, mode = '') {
  await closeWindow();
  win = new BrowserWindow({ width, height: width < 400 ? 820 : 1000, show:false,focusable:false,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true,spellcheck:false} });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('console-message', (_e,level,message) => { if(level>=2)report.errors.push(message); });
  await win.loadURL(origin+'/index.html?mode='+mode);
  for(let i=0;i<80;i++){if(await js('!!window.referenceFixture && !!document.querySelector(".fl-shot-editor__frames")'))break;await pause(25);}
  assert.equal(await js('!!document.querySelector(".fl-shot-editor__frames")'),true);
  win.webContents.debugger.attach('1.3'); await cdp('Emulation.setFocusEmulationEnabled',{enabled:true}); await pause(100);
}
async function focusState(selector) {
  return js(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(e),r=e.getBoundingClientRect();return {active:document.activeElement===e,documentFocus:document.hasFocus(),visible:e.matches(':focus-visible'),outline:s.outlineWidth,outlineStyle:s.outlineStyle,rect:r.toJSON(),viewport:{w:innerWidth,h:innerHeight}};})()`);
}
async function geometry(label) {
  const data = await js(`(() => {
    const r=e=>e.getBoundingClientRect().toJSON();
    return {viewport:innerWidth,document:document.documentElement.scrollWidth,panel:r(document.querySelector('.fl-shot-editor')),
      images:Array.from(document.querySelectorAll('.fl-shot-editor__image img')).map(e=>({box:r(e),parent:r(e.parentElement),natural:[e.naturalWidth,e.naturalHeight],fit:getComputedStyle(e).objectFit})),
      controls:Array.from(document.querySelectorAll('.fl-shot-editor__reference')).flatMap(d=>[d.querySelector('summary'),...(d.open?d.querySelectorAll('select,input,button'):[])]).map(e=>({tag:e.tagName,type:e.type,text:e.getAttribute('aria-label')||e.textContent,box:r(e),parent:r(e.closest('.fl-shot-editor__frame')),sw:e.scrollWidth,cw:e.clientWidth})),
      open:Array.from(document.querySelectorAll('.fl-shot-editor__reference')).map(d=>d.open)};
  })()`);
  report.metrics[label] = data;
  assert.equal(data.document,data.viewport,'No horizontal document overflow');
  for(const image of data.images){assert.equal(image.fit,'contain');assert.ok(image.box.width<=image.parent.width+1&&image.box.height<=image.parent.height+1,'Portrait and panoramic elements fit own thumbnail');assert.ok(image.box.top>=image.parent.top-1&&image.box.bottom<=image.parent.bottom+1);}
  for(const c of data.controls){assert.ok(c.box.left>=c.parent.left-1&&c.box.right<=c.parent.right+1,'Control fits its role card: '+c.text);assert.ok(c.sw<=c.cw+1,'Control scroll box fits; UA subcontrol text is not measurable here: '+c.text);}
}
async function run() {
  await app.whenReady(); assert.equal(app.isPackaged,false);
  const files = new Map([['/index.html',['index.html','text/html']],['/fixture.js',['fixture.js','application/javascript']],['/fixture.css',['fixture.css','text/css']],['/api/media/start',['first.svg','image/svg+xml']],['/api/media/end',['last.svg','image/svg+xml']],['/api/media/candidate',['first.svg','image/svg+xml']]]);
  session.defaultSession.setPermissionRequestHandler((_a,_b,done)=>done(false)); session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.protocol.handle('https',async request=>{
    const url=new URL(request.url);report.requests.push({path:url.pathname,method:request.method});
    if(url.origin!==origin||request.method!=='GET')return new Response('Denied',{status:403});
    if(url.pathname==='/api/media/broken')return new Response('not an image',{headers:{'content-type':'image/png'}});
    const target=files.get(url.pathname);if(!target)return new Response('Denied',{status:403});
    return new Response(await fs.readFile(path.join(scratch,target[0])),{headers:{'content-type':target[1]}});
  });
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith(origin+'/')}));
  for(const width of [1440,390,320]) {
    await load(width);
    await check('compact roles and portrait/panoramic bounds '+width,async()=>{
      assert.equal(await isOpen('Start'),false);assert.equal(await isOpen('End'),false);
      await focus(summary('Start'));await geometry('closed-'+width);await capture('closed-'+width);
      assert.deepEqual((await state()).commands,[]);assert.deepEqual((await state()).uploads,[]);assert.deepEqual((await state()).dirty,[]);
    });
    for(const role of ['Start','End']) await check('native '+role+' Enter/Tab/Escape/Space/close lifecycle '+width,async()=>{
      await focus(summary(role)); await key('Enter');assert.equal(await isOpen(role),true);
      await key('Tab');assert.equal((await focusState(select(role))).active,true,'Tab reaches role select');
      await key('Escape');assert.equal(await isOpen(role),false,'Escape closes disclosure');
      const f=await focusState(summary(role));report.metrics['focus-'+width+'-'+role]=f;
      assert.ok(f.active&&f.documentFocus&&f.visible&&parseFloat(f.outline)>=2,'Keyboard restores a visible focus outline to its role summary');
      if(role==='End') await capture('escape-focus-'+width);
      await key('Space');assert.equal(await isOpen(role),true,'Space reopens after Escape');
      await focus(closeButton(role));await key('Space');assert.equal(await isOpen(role),false,'Space activates separate Close');
      assert.equal((await focusState(summary(role))).active,true);assert.deepEqual(await bindings(),['start','end']);
      assert.deepEqual((await state()).dirty,[]);assert.deepEqual((await state()).commands,[]);assert.deepEqual((await state()).uploads,[]);
    });
    await check('pointer close is independent and expanded controls fit '+width,async()=>{
      await click(summary('Start'));await click(summary('End'));assert.equal(await isOpen('Start'),true);assert.equal(await isOpen('End'),true);
      await geometry('open-'+width);await focus(closeButton('End'));await capture('open-'+width);
      await click(closeButton('End'));assert.equal(await isOpen('End'),false);assert.equal(await isOpen('Start'),true);assert.equal((await focusState(summary('End'))).active,true);
      await click(summary('Start'));assert.equal(await isOpen('Start'),false);
    });
  }
  await load(1440);
  await check('240px containing panel on desktop needs no new CSS',async()=>{
    await js(`document.querySelector('.fl-workspace__composer').style.width='240px'`);
    await click(summary('Start'));await click(summary('End'));await geometry('panel-240');await focus(closeButton('End'));await capture('panel-240');
  });
  await load(1440);
  await check('native cancel plus explicit selection and close retain role, dirty and saved authority',async()=>{
    await focus(summary('End'));await key('Enter');await key('Tab');
    // A real collapsed select keyboard cancel, without substituting synthetic key events.
    await key('Escape');assert.deepEqual(await bindings(),['start','end']);assert.deepEqual((await state()).dirty,[]);
    await click(summary('End'));
    // Pointer option selection cannot be witnessed in an invisible macOS OS popup.
    // Deliver one selection intent through the actual native DOM/React control.
    await js(`(()=>{const s=document.querySelector(${JSON.stringify(select('End'))});s.value='start';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click(closeButton('End'));
    assert.deepEqual(await bindings(),['start','start']);assert.deepEqual((await state()).dirty,['reference-shot']);assert.deepEqual((await state()).commands,[]);
    assert.equal((await state()).saved.bindings.lastFrameAssetId,'end','No automatic save');
    await click('.fl-shot-editor__footer-actions button:first-child');
    const saved=await state();assert.equal(saved.commands.length,1);assert.equal(saved.commands[0].type,'shot.update');assert.deepEqual(saved.saved.bindings,{firstFrameAssetId:'start',lastFrameAssetId:'start'});assert.deepEqual(saved.dirty,[]);
  });
  await load(390);
  await check('closing pending import keeps reference and visible status; completion never steals prompt focus',async()=>{
    await click(summary('End'));
    await js(`(()=>{const e=document.querySelector('input[id$="last_frame-upload"]'),d=new DataTransfer();d.items.add(new File(['fixture'],'owned.png',{type:'image/png'}));e.files=d.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click(closeButton('End'));assert.deepEqual(await bindings(),['start','end']);
    assert.equal(await js(`document.querySelector('.fl-shot-editor__upload-note').textContent.includes('Importing owned.png')`),true);
    await focus('.fl-prompt-composer textarea');await win.webContents.insertText(' Newer local input');await pause();
    const prompt=await js(`document.querySelector('.fl-prompt-composer textarea').value`);
    await js('window.referenceFixture.finishUpload()');await pause(180);
    assert.deepEqual(await bindings(),['start','candidate']);assert.equal(await isOpen('End'),false);
    assert.equal((await focusState('.fl-prompt-composer textarea')).active,true);assert.equal(await js(`document.querySelector('.fl-prompt-composer textarea').value`),prompt);
    assert.deepEqual((await state()).commands,[]);await capture('pending-completed-390');
  });
  for(const mode of ['missing','failed','loaded']) {
    await load(390,mode==='loaded'?'':mode);
    await check('A12 native '+mode+' assigned End review guard',async()=>{
      assert.deepEqual(await bindings(),['start','end']);await click('.fl-shot-editor__footer-actions button:last-child');
      for(let i=0;i<40;i++){if(await js('!!document.querySelector("dialog[open]")'))break;await pause(50);}
      await pause(180);
      const result=await js(`(()=>{const d=document.querySelector('dialog[open]');return {buttons:Array.from(d.querySelectorAll('button')).map(b=>({name:b.textContent,disabled:b.disabled})),images:Array.from(d.querySelectorAll('img')).map(i=>({complete:i.complete,natural:i.naturalWidth}))};})()`);
      report.metrics['review-'+mode]=result;
      assert.equal(result.buttons.find(b=>b.name.includes('Approve this generation')).disabled,mode!=='loaded');
      assert.equal(result.buttons.find(b=>b.name.includes('Generate once')).disabled,true);
      assert.deepEqual((await state()).commands.map(c=>c.type),['generation.prepare']);await capture('review-'+mode);
    });
  }
}
void run().catch(error=>report.errors.push(error.stack)).finally(async()=>{
  try{await closeWindow();report.cleanup.windowsRemaining=BrowserWindow.getAllWindows().length;}catch(error){report.errors.push(error.stack);}
  report.success=report.errors.length===0&&report.checks.length>0&&report.checks.every(c=>c.passed);
  await fs.writeFile(path.join(evidence,'native-report.json'),JSON.stringify(report,null,2));
  app.exit(report.success?0:1);
});
