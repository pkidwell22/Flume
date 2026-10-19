const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const assert = require('node:assert/strict');
const [scratch, evidence, filter] = process.argv.slice(2);
app.setPath('userData', path.join(scratch, 'user')); app.setPath('sessionData', path.join(scratch, 'session')); app.setPath('logs', path.join(scratch, 'logs'));
app.setActivationPolicy('accessory'); app.disableHardwareAcceleration();
const report = { liveApp: false, runtime: process.versions, checks: [], errors: [], cleanup: {} };
let win;
const pause = (ms = 65) => new Promise(resolve => setTimeout(resolve, ms));
const js = source => win.webContents.executeJavaScript(source, true);
const model = '.fl-model-picker__trigger', guidance = '.fl-prompt-composer__toolbar button';
const modelPanel = '.fl-model-picker__panel', guidancePanel = '.fl-prompt-composer__directions';
async function click(selector) {
  const point = await js(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('Missing pointer target'); const r=el.getBoundingClientRect(); const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2); return {x,y,hit:el.contains(document.elementFromPoint(x,y))}; })()`);
  assert.equal(point.hit, true, 'Native pointer must hit the intended control: ' + selector);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await pause();
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (['Enter', 'Space'].includes(keyCode)) win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ', modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await pause();
}
async function reset(width = 1100, height = 900) {
  win.setSize(width, height); await pause();
  await js(`window.fixture.reset(); document.querySelector('#stage').style.cssText=''; document.querySelector('#scroller').scrollTop=0;`); await pause();
}
async function align(selector, x, y, width = 840) {
  await js(`(() => {const stage=document.querySelector('#stage');stage.style.width=${JSON.stringify(width + 'px')}; stage.style.left='0px';stage.style.top='0px';const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();stage.style.left=(${x}-r.left)+'px';stage.style.top=(${y}-r.top)+'px';})()`); await pause();
}
const rect = selector => js(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};})()`);
async function geometry(trigger, panel) {
  return js(`(() => {const t=document.querySelector(${JSON.stringify(trigger)}),p=document.querySelector(${JSON.stringify(panel)}); const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};}; return {anchor:rect(t),popup:p?rect(p):null,position:p?getComputedStyle(p).position:null,viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,containerType:getComputedStyle(document.querySelector('.fl-shot-editor')).containerType,active:document.activeElement?.getAttribute('aria-label')||document.activeElement?.id||document.activeElement?.textContent};})()`);
}
function bounded(g) { assert.ok(g.popup, 'Popup exists'); assert.ok(g.popup.left >= 11 && g.popup.top >= 11 && g.popup.right <= g.viewport.width - 11 && g.popup.bottom <= g.viewport.height - 11, 'Popup stays within 12px viewport gutters: '+JSON.stringify(g)); assert.ok(g.documentWidth <= g.viewport.width, 'No horizontal document overflow'); }
async function capture(name) { assert.equal(win.isVisible(), false); const image=await win.webContents.capturePage(undefined,{stayHidden:true}); assert.equal(image.isEmpty(),false); await fs.writeFile(path.join(evidence,name+'.png'), image.toPNG()); }
async function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  const item={name,passed:false};
  try { item.details=await fn(); item.passed=true; }
  catch (e) { item.error={message:e.message,stack:e.stack}; await capture('failure-'+report.checks.length); }
  report.checks.push(item);
}
async function run() {
  await app.whenReady(); assert.equal(app.isPackaged,false);
  session.defaultSession.setPermissionRequestHandler((_a,_b,done)=>done(false)); session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>{ let allowed=false;try {allowed=details.url.startsWith('file:')&&fileURLToPath(details.url).startsWith(scratch+path.sep);}catch{} done({cancel:!allowed}); });
  win=new BrowserWindow({width:1100,height:900,show:false,focusable:false,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true,spellcheck:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'})); win.webContents.on('will-navigate',e=>e.preventDefault());
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=2)report.errors.push(message);});
  await win.loadURL(pathToFileURL(path.join(scratch,'index.html')).href); await pause();
  assert.equal(await js('!!window.fixture'),true);
  win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await check('first-open model is anchored below without editor reflow inside container-type', async()=>{
    await reset(); await align(model,60,140);
    const before=await rect('.fl-shot-editor__footer');
    // Observe the very first animation frame after the real pointer activation.
    await js(`window.firstPlacement=null;document.querySelector(${JSON.stringify(model)}).addEventListener('click',()=>requestAnimationFrame(()=>{const p=document.querySelector(${JSON.stringify(modelPanel)}),t=document.querySelector(${JSON.stringify(model)});window.firstPlacement={popup:p?.getBoundingClientRect().toJSON(),anchor:t.getBoundingClientRect().toJSON()};}),{once:true})`);
    await click(model); const g=await geometry(model,modelPanel); const first=await js('window.firstPlacement');
    bounded(g); assert.equal(g.containerType,'inline-size'); assert.equal(g.position,'fixed');
    assert.ok(Math.abs(g.popup.top-g.anchor.bottom-8)<2,'Below anchor with 8px gap');
    assert.ok(Math.abs(first.popup.top-first.anchor.bottom-8)<2,'Correct on FIRST paint');
    assert.deepEqual(await rect('.fl-shot-editor__footer'),before,'Opening does not expand the editor');
    assert.equal(await js('document.activeElement.getAttribute("role")'),'combobox');
    await capture('model-first-open');return {g,first};
  });
  await check('first-open guidance is anchored below without reflow or implicit edits', async()=>{
    await reset(); await align(guidance,60,140);
    const before=await rect('.fl-shot-editor__footer');
    await js(`window.firstGuidance=null;document.querySelector(${JSON.stringify(guidance)}).addEventListener('click',()=>requestAnimationFrame(()=>{const p=document.querySelector(${JSON.stringify(guidancePanel)}),t=document.querySelector(${JSON.stringify(guidance)});window.firstGuidance={popup:p?.getBoundingClientRect().toJSON(),anchor:t.getBoundingClientRect().toJSON()};}),{once:true})`);
    await click(guidance);const g=await geometry(guidance,guidancePanel);const first=await js('window.firstGuidance');
    bounded(g);assert.equal(g.position,'fixed');assert.ok(Math.abs(first.popup.top-first.anchor.bottom-8)<2,'Guidance below on first paint');
    assert.deepEqual(await rect('.fl-shot-editor__footer'),before,'Guidance must not expand the editor');
    assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Insert Static shot');
    assert.equal(await js('window.fixture.state().dirty.at(-1)'),false,'Opening never edits');
    await capture('guidance-first-open');return {g,first};
  });
  for (const [name,trigger,panel] of [['model',model,modelPanel],['guidance',guidance,guidancePanel]]) {
    await check(name+' flips at the bottom, clamps the right edge and fits a 320px viewport',async()=>{
      await reset(); await align(trigger,850,780,240); await click(trigger);
      const edge=await geometry(trigger,panel);bounded(edge);
      assert.ok(Math.abs(edge.anchor.top-edge.popup.bottom-8)<2,'Bottom collision flips above');
      assert.ok(Math.abs(edge.popup.right-edge.viewport.width+12)<2,'Right edge clamps to the 12px safety inset');
      await key('Escape');await reset(320,640);await align(trigger,29,420,304);await click(trigger);
      const narrow=await geometry(trigger,panel);bounded(narrow);
      assert.equal(narrow.popup.width,296,'Twelve-pixel gutters at 320px');
      assert.ok(await js(`(()=>{const p=document.querySelector(${JSON.stringify(panel)});return p.scrollWidth<=p.clientWidth+1;})()`),'No horizontal popup clipping');
      await capture(name+'-320px');return {edge,narrow};
    });
    await check(name+' follows scroll and resize, then closes when its anchor leaves the scrollport',async()=>{
      await reset();await align(trigger,60,600);await click(trigger);
      const before=await geometry(trigger,panel);
      await js('document.querySelector("#scroller").scrollTop=50');await pause();
      const scrolled=await geometry(trigger,panel);bounded(scrolled);
      assert.ok(Math.abs(scrolled.anchor.top-before.anchor.top+50)<2,'Actual ancestor scroll moves anchor');
      assert.ok(Math.abs(scrolled.popup.bottom-scrolled.anchor.top+8)<2,'Popup tracks the new anchor');
      win.setSize(800,720);await pause(130);const resized=await geometry(trigger,panel);bounded(resized);
      await js('document.querySelector("#scroller").scrollTop=1200');await pause();
      assert.equal(await js(`!!document.querySelector(${JSON.stringify(panel)})`),false,'Offscreen anchor must dismiss, not leave a detached popup');
      return {before,scrolled,resized};
    });
  }
  await check('native switching is exclusive and delayed cleanup never restores an obsolete trigger',async()=>{
    await reset();await align(model,40,570,1040);
    for(let i=0;i<3;i++) {
      await click(model);await click(guidance);await pause(220);
      assert.equal(await js('document.querySelectorAll("[popover]").length'),1);
      assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Insert Static shot');
      await click(model);await pause(220);
      assert.equal(await js('document.querySelectorAll("[popover]").length'),1);
      assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Search models');
      await key('Escape');
    }
    assert.equal(await js('window.fixture.state().dirty.at(-1)'),false);
  });
  await check('Escape, outside pointer and Tab dismiss without implicit changes or stale focus',async()=>{
    await reset();await align(model,40,570,1040);
    for(const trigger of [model,guidance]) {
      await click(trigger);await key('Escape');
      assert.equal(await js(`document.activeElement===document.querySelector(${JSON.stringify(trigger)})`),true);
      await click(trigger);await click('#outside');await pause(200);
      assert.equal(await js('document.activeElement.id'),'outside');
      assert.equal(await js('document.querySelectorAll("[popover]").length'),0);
      await click(trigger);await click('#nonfocus');await pause(200);
      assert.equal(await js('document.querySelectorAll("[popover]").length'),0,'Nonfocusable outside surface dismisses');
    }
    await click(guidance);
    for(let i=0;i<7;i++)await key('Tab');
    assert.equal(await js('document.activeElement===document.querySelector(".fl-model-picker__trigger")'),true,'Tab leaves guidance into the next control');
    assert.equal(await js('document.querySelectorAll("[popover]").length'),0);
    await key('Down');await key('Tab');
    assert.equal(await js('document.querySelectorAll("[popover]").length'),0,'Tab leaves the model popup');
    assert.equal(await js('window.fixture.state().dirty.at(-1)'),false);
  });
  await check('native explicit choices retain exact model identity and literal prompt, dirty and review gates',async()=>{
    await reset();await align(model,40,570,1040);await click(model);await key('Down');
    assert.equal(await js('window.fixture.state().dirty.at(-1)'),false);
    await key('Enter');
    assert.equal(await js('document.querySelector(".fl-model-picker__trigger").value'),'  fixture/Mixed-ID  ');
    assert.equal(await js('window.fixture.state().dirty.at(-1)'),true);
    assert.equal(await js('document.querySelector(".fl-shot-editor__primary").disabled'),true);
    await click(guidance);await key('Tab');await key('Space');
    assert.equal(await js('document.activeElement.tagName'),'TEXTAREA');
    assert.equal(await js('document.querySelector("textarea").value'),'  Literal prompt\nwith an untouched ending.  Move the camera toward the subject.');
    assert.deepEqual(await js('window.fixture.state().saves'),[]);assert.deepEqual(await js('window.fixture.state().prepares'),[]);
  });
  await check('busy closure and unlock preserve newer outside focus and never reopen stale popups',async()=>{
    // ShotEditor intentionally leaves editable buffers enabled while busy. Test
    // the components' explicit disabled contract separately, without changing it.
    await reset();await js('window.fixture.reset(true)');await pause();await align(model,40,570,1040);
    for(const trigger of [model,guidance]) {
      await click(trigger);await js('window.fixture.lock(true)');await pause();
      assert.equal(await js('document.querySelectorAll("[popover]").length'),0);
      await click('#outside');await js('window.fixture.lock(false)');await pause(220);
      assert.equal(await js('document.activeElement.id'),'outside');
      assert.equal(await js('document.querySelectorAll("[popover]").length'),0);
    }
    assert.deepEqual(await js('window.fixture.state().saves'),[]);assert.deepEqual(await js('window.fixture.state().prepares'),[]);
  });
  await check('search content resizing keeps the popup attached above and all keyboard results visible',async()=>{
    await reset();await align(model,60,760);await click(model);
    const before=await geometry(model,modelPanel);
    await win.webContents.insertText('not-in-catalog');await pause(160);
    const filtered=await geometry(model,modelPanel);bounded(filtered);
    assert.ok(filtered.popup.height<before.popup.height,'The empty result shrinks naturally');
    assert.ok(Math.abs(filtered.anchor.top-filtered.popup.bottom-8)<2,'Shortened popup remains anchored above');
    await click('.fl-model-picker__search-row button');
    await key('End',['control']);const end=await geometry(model,modelPanel);bounded(end);
    assert.ok(Math.abs(end.anchor.top-760)<2,'Navigating results never scrolls the editor');
    const active=await js(`(()=>{const s=document.querySelector('.fl-model-picker__search'),el=document.getElementById(s.getAttribute('aria-activedescendant')),r=el.getBoundingClientRect(),p=document.querySelector('.fl-model-picker__results').getBoundingClientRect();return {top:r.top,bottom:r.bottom,containerTop:p.top,containerBottom:p.bottom};})()`);
    assert.ok(active.top>=active.containerTop-1&&active.bottom<=active.containerBottom+1,'Keyboard active option is visible');
    return {before,filtered,end,active};
  });
  await check('outside pointer dismisses guidance even when the target suppresses focus transfer',async()=>{
    await reset();await align(model,40,570,1040);await click(guidance);
    await js(`document.querySelector('#nonfocus').addEventListener('pointerdown',e=>e.preventDefault(),{once:true})`);
    await click('#nonfocus');await pause(200);
    assert.equal(await js('document.querySelectorAll("[popover]").length'),0,'Outside pointer dismissal cannot depend on blur');
    assert.equal(await js('document.activeElement===document.querySelector(".fl-prompt-composer__toolbar button")'),false,'Outside dismissal never restores the old anchor');
    assert.equal(await js('window.fixture.state().dirty.at(-1)'),false);
  });
  await check('320px keyboard traversal reaches Close and exposes named nonmodal popups to Chromium AX',async()=>{
    await reset(320,640);await align(guidance,29,420,304);
    await js('document.querySelector(".fl-prompt-composer__toolbar button").focus()');await key('Space');
    for(let i=0;i<6;i++)await key('Tab');
    assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Close camera directions');
    const g=await geometry(guidance,guidancePanel);bounded(g);
    const focus=await js(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),s=getComputedStyle(e);return {top:r.top,bottom:r.bottom,outline:s.outlineWidth,visible:e.matches(':focus-visible'),hasFocus:document.hasFocus()};})()`);
    assert.ok(focus.top>=g.popup.top&&focus.bottom<=g.popup.bottom,'Close is reachable without page scroll: '+JSON.stringify({g,focus}));
    assert.equal(focus.visible,true);assert.equal(focus.outline,'3px');
    assert.ok(focus.top>=g.popup.top+7&&focus.bottom<=g.popup.bottom-7,'The focused Close outline must not be clipped by the popup');
    await win.webContents.debugger.sendCommand('Accessibility.enable');
    const ax=await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
    const dialogs=ax.nodes.filter(n=>n.role?.value==='dialog').map(n=>({name:n.name?.value,properties:n.properties}));
    assert.equal(dialogs.length,1);assert.equal(dialogs[0].name,'Camera direction guidance');
    assert.equal(dialogs[0].properties.find(p=>p.name==='modal')?.value.value,false);
    await capture('guidance-320px-keyboard-close');await key('Escape');
    assert.equal(await js('document.activeElement===document.querySelector(".fl-prompt-composer__toolbar button")'),true);
    return {g,focus,dialogs};
  });
  await check('local control feedback is 150ms and reduced motion keeps popups visible without animation',async()=>{
    await reset();await align(model,40,570,1040);
    const durations=()=>js(`['.fl-model-picker__trigger','.fl-prompt-composer__toolbar button'].map(s=>getComputedStyle(document.querySelector(s)).transitionDuration)`);
    assert.deepEqual(await durations(),['0.15s, 0.15s','0.15s, 0.15s']);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.deepEqual(await durations(),['0s','0s']);
    for(const [trigger,panel] of [[model,modelPanel],[guidance,guidancePanel]]) {
      await click(trigger);const g=await geometry(trigger,panel);bounded(g);
      assert.deepEqual(await js(`(()=>{const s=getComputedStyle(document.querySelector(${JSON.stringify(panel)}));return [s.opacity,s.animationName,s.transform];})()`),['1','none','none']);
      await key('Escape');await click(trigger);await key('Escape');
      assert.equal(await js('document.querySelectorAll("[popover]").length'),0,'No ghost overlays after rapid reopen');
    }
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
  });
  await check('top layer escapes a transformed clipping ancestor with actual viewport geometry',async()=>{
    await reset();await align(model,60,600);
    await js('document.querySelector("#canvas").style.transform="translateZ(0)"');
    try {
      await click(model);const g=await geometry(model,modelPanel);bounded(g);
      assert.ok(Math.abs(g.anchor.top-g.popup.bottom-8)<2,'Transform must not offset the popup from its anchor');
      assert.ok(g.popup.top<110,'The popup crosses above the scrollport clipping edge');
      await click('.fl-model-picker__search');
      assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Search models');
      return g;
    } finally { await js('document.querySelector("#canvas").style.transform=""'); }
  });
  report.success=report.checks.length>0&&report.checks.every(c=>c.passed)&&report.errors.length===0;
}
void run().catch(e=>{report.fatal={message:e.message,stack:e.stack};report.success=false;}).finally(async()=>{
  if(win&&!win.isDestroyed()) {report.cleanup.hiddenThroughout=!win.isVisible();try {if(win.webContents.debugger.isAttached()){await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});report.cleanup.mediaEmulationCleared=true;await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});report.cleanup.focusEmulationCleared=true;win.webContents.debugger.detach();}}catch(e){report.cleanup.error=e.message;}win.destroy();report.cleanup.windowDestroyed=win.isDestroyed();}
  await fs.writeFile(path.join(evidence,'native-report.json'),JSON.stringify(report,null,2)+'\n');app.exit(report.success?0:1);
});
