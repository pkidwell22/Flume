const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs');const path=require('node:path');
const output=process.argv[2],profile=process.argv[3],url=process.argv[4]||'http://127.0.0.1:4310';
if(!output||!profile||!url.startsWith('http://127.0.0.1:'))throw new Error('Explicit owned output/profile/local URL required');
app.setPath('userData',path.join(profile,'user'));app.setPath('sessionData',path.join(profile,'session'));app.setActivationPolicy('accessory');
const report={checks:[],errors:[]};let window;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const js=code=>window.webContents.executeJavaScript(code,true);
async function until(code){for(let n=0;n<200;n++){if(await js(code))return;await wait(100);}throw new Error('UI timeout: '+code);}
async function capture(name){await wait(150);const image=await window.webContents.capturePage(undefined,{stayHidden:true});if(image.isEmpty())throw new Error('Empty capture');fs.writeFileSync(path.join(output,name+'.png'),image.toPNG());}
(async()=>{await app.whenReady();if(app.isPackaged)throw new Error('Packaged runtime forbidden');
 session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{const parsed=new URL(details.url);callback({cancel:!['devtools:'].includes(parsed.protocol)&&parsed.host!==new URL(url).host});});
 window=new BrowserWindow({width:1500,height:1100,show:false,focusable:false,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('console-message',(_event,level,message)=>{if(level>=2)report.errors.push(message);});
 await window.loadURL(url);await until("document.querySelector('main') && !document.body.textContent.includes('Opening your workspace')");
 report.initial=await js("({title:document.title,buttons:[...document.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled})),inputs:[...document.querySelectorAll('input,textarea,select')].map(e=>({tag:e.tagName,id:e.id,type:e.type,label:e.labels?.[0]?.textContent})),text:document.body.innerText})");
 await capture('initial');
 if(process.argv.includes('--workflow')){
  // Use the real app's dialog and event handlers, never direct command POSTs.
  await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='New project').click()");
  await until("document.querySelector('dialog[open] #fl-create-name')");
  await js("(()=>{const e=document.querySelector('#fl-create-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Local integration / SAMPLE frames');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await js("document.querySelector('dialog form').requestSubmit()");
  await until("!document.querySelector('dialog[open]') && document.body.textContent.includes('Make your first shot')");
  await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Create a shot').click()");
  await until("document.querySelector('#fl-create-name')");
  await js("(()=>{const e=document.querySelector('#fl-create-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Two separate moments');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await js("document.querySelector('dialog form').requestSubmit()");
  await until("document.querySelector('.fl-shot-editor textarea')");
  report.checks.push('Created project and shot through actual browser handlers');
  report.editor=await js("({buttons:[...document.querySelectorAll('.fl-shot-editor button')].map(b=>({text:b.textContent,disabled:b.disabled})),inputs:[...document.querySelectorAll('.fl-shot-editor input,.fl-shot-editor textarea')].map(e=>({id:e.id,type:e.type,label:e.labels?.[0]?.textContent}))})");
  await capture('created-shot');
  for(const role of ['first_frame','last_frame']){
   const bytes=fs.readFileSync(path.join(output,'..',role+'.png')).toString('base64');
   await js(`(()=>{const e=document.querySelector('input[id$="${role}-upload"]');const bytes=Uint8Array.from(atob(${JSON.stringify(bytes)}),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([bytes],'SAMPLE-${role}.png',{type:'image/png'}));e.files=dt.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   await until(`document.body.textContent.includes('SAMPLE-${role}.png') && !document.body.textContent.includes('Saving / checking')`);
  }
  await js(`(()=>{const e=document.querySelector('.fl-shot-editor textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'  Two distinct SAMPLE frames. Keep their roles.  ');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  if(process.argv.includes('--seed-check'))await js("(()=>{const e=document.querySelector('input[id$=seed]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'0');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  if(process.argv.includes('--sample')){
   await js("(()=>{const e=document.querySelector('select[id$=model]');e.value='sample/local';e.dispatchEvent(new Event('change',{bubbles:true}));for(const [suffix,value] of [['duration','3'],['resolution','360p']]){const i=document.querySelector('input[id$='+suffix+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,value);i.dispatchEvent(new Event('input',{bubbles:true}));}})()");
  }
  await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Save changes').click()");
  await until("document.body.textContent.includes('Shot saved.') && !document.body.textContent.includes('Unsaved changes')");
  const saved=await js("fetch('/api/workspace?projectId='+document.querySelector('#fl-project').value).then(r=>r.json())");
  const shot=saved.shots[0];if(!shot.bindings.firstFrameAssetId||!shot.bindings.lastFrameAssetId||shot.bindings.firstFrameAssetId===shot.bindings.lastFrameAssetId||shot.prompt!=='  Two distinct SAMPLE frames. Keep their roles.  ')throw new Error('Saved literal intent or separate roles lost');
  report.projectId=saved.project.id;report.shotId=shot.id;report.checks.push('Distinct browser File uploads owned and explicitly bound; exact prompt persisted');
  if(process.argv.includes('--seed-check')){
   if(shot.controls.seed!==0)throw new Error('UI seed zero was not retained');
   await js("(()=>{const e=document.querySelector('input[id$=seed]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
   await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Save changes').click()");
   await until("!document.body.textContent.includes('Unsaved changes') && !document.body.textContent.includes('Saving / checking')");
   const cleared=await js("fetch('/api/workspace?projectId='+document.querySelector('#fl-project').value).then(r=>r.json())");
   if(Object.hasOwn(cleared.shots[0].controls,'seed'))throw new Error('UI seed clear was ineffective');
   report.checks.push('Native input seed zero persisted; explicit blank cleared it through canonical null patch');
  }

  if(process.argv.includes('--discard-check')){
   for(const target of ['New project','current-shot']){
    await js("(()=>{const e=document.querySelector('.fl-shot-editor textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Discard this unsaved buffer');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
    if(target==='New project')await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='New project').click()");
    else await js("document.querySelector('.fl-workspace__shot[aria-current=page]').click()");
    await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Discard and continue')");
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Discard and continue').click()");
    if(target==='New project'){
     await until("document.querySelector('dialog[open] #fl-create-name')");
     await js("[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Cancel').click()");
    }
    await until("!document.querySelector('dialog[open]')");
    if(await js("document.querySelector('.fl-shot-editor textarea').value")!==shot.prompt)throw new Error('Discard did not reset the mounted editor: '+target);
   }
   report.checks.push('Explicit discard resets the actual editor even after canceled creation or same-shot navigation');
  }
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Review generation'&&!b.disabled)");
  await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Review generation').click()");
  await until("document.querySelector('dialog.fl-review[open]')");
  await until("[...document.querySelectorAll('dialog.fl-review img')].every(i=>i.complete&&i.naturalWidth>0)");
  report.review=await js("({text:document.querySelector('dialog.fl-review').innerText,approveDisabled:[...document.querySelectorAll('button')].find(b=>b.textContent==='Approve this generation').disabled,submitDisabled:[...document.querySelectorAll('button')].find(b=>b.textContent==='Generate once').disabled})");
  if(!process.argv.includes('--sample')&&(!report.review.approveDisabled||!report.review.submitDisabled))throw new Error('Known blocked provider must not allow generation');
  await capture('exact-review');
  if(!process.argv.includes('--sample')){
   report.checks.push('Actual blocked H3 review shows exact two frames; no approval or submit enabled');
   await js("[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Close review').click()");
  }
  if(process.argv.includes('--sample')){
   await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Approve this generation').click()");
   await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Generate once'&&!b.disabled)");
   await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Generate once').click()");
   await until("document.querySelector('.fl-tr-take video')");
   if(await js("document.querySelector('.fl-tr-take').dataset.selected==='true'"))throw new Error('Take auto-selected');
   report.checks.push('Explicit approval and one sample submission produced an owned unselected Sample take through pg-boss');
   await js("document.querySelector('.fl-workspace__takes').scrollIntoView({block:'start'})");
   report.playback=await js("(async()=>{const v=document.querySelector('.fl-tr-take video');await v.play();const before={time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames};await new Promise(r=>setTimeout(r,700));const after={time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,width:v.videoWidth,height:v.videoHeight,error:v.error?.code??null};v.pause();return {before,after};})()");
   if(report.playback.after.time<=report.playback.before.time||report.playback.after.frames<=report.playback.before.frames)throw new Error('Native sample did not play');
   window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
   for(const name of ['Inspect take','Select take']){
    await until(`[...document.querySelectorAll('button')].some(b=>b.textContent===${JSON.stringify(name)}&&!b.disabled)`);
    await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(name)});b.focus();if(${JSON.stringify(name)}==='Select take'){window.__selectedButton=b;window.__takeVideo=document.querySelector('.fl-tr-take video');}})()`);
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});await wait(150);
   }
   await until("document.querySelector('.fl-tr-take').dataset.selected==='true'");
   report.selection=await js("({sameVideo:window.__takeVideo===document.querySelector('.fl-tr-take video'),sameButton:window.__selectedButton===[...document.querySelectorAll('button')].find(b=>b.textContent==='Selected'),focusRetained:document.activeElement===window.__selectedButton})");
   if(!report.selection.sameVideo||!report.selection.sameButton||!report.selection.focusRetained)throw new Error('Selection readback destroyed playback/focus');
   await capture('sample-selected');
   await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Export selected take').click()");
   await until("document.querySelector('a[download]')");
   await js("document.querySelector('.fl-tr-exports').scrollIntoView({block:'start'});document.querySelector('.fl-tr-export-preview').open=true");
   report.exportPlayback=await js("(async()=>{const v=document.querySelector('.fl-tr-export video');await v.play();const before=v.currentTime;await new Promise(r=>setTimeout(r,700));v.pause();return {before,after:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,error:v.error?.code??null};})()");
   if(report.exportPlayback.after<=report.exportPlayback.before)throw new Error('Frozen sample export did not play');
   report.export=await js("(async()=>{const w=await fetch('/api/workspace?projectId='+document.querySelector('#fl-project').value).then(r=>r.json());const e=w.exports[0],a=w.assets.find(a=>a.id===e.assetId);const bytes=await fetch(a.mediaUrl).then(r=>r.arrayBuffer());const h=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');return {status:e.status,hashMatches:h===a.sha256,origin:a.origin,takes:w.takes.length,attempts:w.attempts.length,exports:w.exports.length};})()");
   if(!report.export.hashMatches||report.export.origin!=='sample'||report.export.attempts!==1||report.export.exports!==1)throw new Error('Export identity/count/source failed');
   await capture('sample-frozen-export');
   // A controlled transient browser failure exercises a real source reload without a command.
   await js("document.querySelector('.fl-tr-take video').dispatchEvent(new Event('error'))");
   await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Reload take preview').click()");
   await until("document.querySelector('.fl-tr-take video').readyState>=2");
   if(!await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Inspect take').disabled"))throw new Error('Reload retained inspection authority');
   await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});window.webContents.debugger.detach();
   report.checks.push('Native playback, keyboard inspection/selection, stable selection focus, frozen export playback/hash, explicit read-only reload');
  }
  await js('scrollTo(0,0)');await capture('saved-frames');
  report.overflow=await js("[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})).slice(0,12)");

 }
 if(process.argv.includes('--responsive')){
  window.setContentSize(390,900);await wait(350);
  await until('innerWidth===390');
  report.narrow=await js('({viewport:innerWidth,document:document.documentElement.scrollWidth})');
  if(report.narrow.document>report.narrow.viewport)throw new Error('Narrow product overflow');
  await js("(document.querySelector('.fl-tr-exports')??document.querySelector('main')).scrollIntoView({block:'start'})");
  await capture('narrow-product');
  window.setContentSize(1500,1100);await wait(250);
 }
 report.hidden=!window.isVisible();report.geometry=await js('({viewport:innerWidth,document:document.documentElement.scrollWidth})');
 fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));window.destroy();app.exit(report.errors.length?1:0);
})().catch(async error=>{report.failure=error.message;try{await capture('failure');}catch{}fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify(report,null,2));console.error(error);window?.destroy();app.exit(1);});
setTimeout(()=>{console.error('Browser witness deadline');app.exit(1);},60000).unref();
