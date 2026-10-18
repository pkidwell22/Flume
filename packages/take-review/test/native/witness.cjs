const {app,BrowserWindow,session}=require('electron');
const {mkdir,writeFile}=require('node:fs/promises');
const {join}=require('node:path');
const assert=require('node:assert/strict');
const [url,output]=process.argv.slice(2);
app.setPath('userData',join(output,'profile'));app.setPath('sessionData',join(output,'session'));
if(process.platform==='darwin')app.setActivationPolicy('accessory');
let window;
const report={scope:'Isolated TakeReview with test-owned sample files; not live generation or integrated exports',screenshots:[],playback:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const evaluate=code=>window.webContents.executeJavaScript(code,true);
async function waitFor(code){for(let i=0;i<100;i++){if(await evaluate(code))return;await pause(50);}throw new Error(`Timed out: ${code}`);}
async function capture(name){await pause(180);assert.equal(window.isVisible(),false);const image=await window.webContents.capturePage(undefined,{stayHidden:true});assert.equal(image.isEmpty(),false);const path=join(output,`${name}.png`);await writeFile(path,image.toPNG());report.screenshots.push(path);console.log(`SCREENSHOT ${path}`);}
async function play(selector,label){
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.readyState >= 2`);
  const before=await evaluate(`(()=>{const v=document.querySelector(${JSON.stringify(selector)});v.muted=true;v.currentTime=0;return {time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames};})()`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).play()`);await pause(650);
  const after=await evaluate(`(()=>{const v=document.querySelector(${JSON.stringify(selector)});v.pause();return {time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,width:v.videoWidth,height:v.videoHeight,error:v.error?.code??null};})()`);
  assert(after.time>before.time+.2);assert(after.frames>before.frames);assert.equal(after.error,null);assert.equal(after.width,960);report.playback.push({label,before,after});console.log('PLAYBACK',JSON.stringify({label,before,after}));
}
async function click(text){await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b||b.disabled)throw new Error('Missing or disabled button: '+${JSON.stringify(text)});b.click();})()`);await pause(80);}
app.whenReady().then(async()=>{
  try {
    assert.equal(app.isPackaged,false);
    session.defaultSession.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));
    session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith(url+'/')}));
    window=new BrowserWindow({width:1280,height:980,show:false,focusable:false,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,target)=>{if(!target.startsWith(url+'/'))event.preventDefault();});
    window.webContents.on('render-process-gone',(_event,details)=>{throw new Error(`Renderer gone: ${details.reason}`);});
    await window.loadURL(url+'/');await waitFor('document.querySelectorAll(".fl-tr-take video").length===2');
    await capture('desktop-initial');
    const geometry=await evaluate(`(()=>{const r=[...document.querySelectorAll('.fl-tr-take video')].map(v=>{const b=v.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height}});return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,players:r};})()`);
    report.desktop=geometry;
    assert.equal(geometry.documentWidth,geometry.width,'desktop document must not overflow');
    assert(Math.abs(geometry.players[0].y-geometry.players[1].y)<2,'desktop players must compare side by side');
    assert(geometry.players.every(p=>p.x>=0&&p.right<=geometry.width&&p.width>300),'both native controls must fit');
    assert.equal(await evaluate('window.fixture.events.length'),0);
    await play('.fl-tr-take video','take-a');
    await play('.fl-tr-take[data-take-id=\"take-b\"] video','take-b');
    await capture('comparison-played');
    await click('Inspect take');await click('Select take');
    await waitFor('[...document.querySelectorAll("button")].some(b=>b.textContent==="Selected")');
    await click('Export selected take');
    assert.equal(await evaluate('document.querySelectorAll("a[download]").length'),0,'queued is not ready');
    await evaluate('window.fixture.ready()');await waitFor('document.querySelectorAll("a[download]").length===1');
    await evaluate('document.querySelector(".fl-tr-export-preview").open=true;document.querySelector(".fl-tr-export").scrollIntoView({block:"center"})');
    await play('.fl-tr-export video','frozen-export');await capture('frozen-export');
    await evaluate('window.fixture.edit()');await waitFor('document.body.textContent.includes("Out of date")');
    const frozenUrl=await evaluate('document.querySelector("a[download]").getAttribute("href")');assert.equal(frozenUrl,'/api/media/output-a');
    await capture('stale-export');
    await evaluate('document.querySelectorAll("details").forEach(d=>d.open=true);window.scrollTo(0,0)');
    window.setContentSize(390,844);await pause(300);await capture('narrow-expanded-details');
    const narrow=await evaluate(`(()=>{const players=[...document.querySelectorAll('.fl-tr-take video')].map(v=>{const r=v.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,width:r.width}});return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,players,hashes:[...document.querySelectorAll('.fl-tr-details dd')].filter(d=>d.textContent.length===64).map(d=>({text:d.textContent,width:d.getBoundingClientRect().width,scrollWidth:d.scrollWidth}))};})()`);
    report.narrow=narrow;assert.equal(narrow.width,narrow.documentWidth,'long identifiers must wrap, not clip or widen the grid');assert(narrow.players[1].y>narrow.players[0].y);assert(narrow.players.every(p=>p.right<=narrow.width&&p.width>=280));
    await evaluate('document.querySelector(".fl-tr-take .fl-tr-details").scrollIntoView({block:"start"})');await capture('narrow-identifiers');
    window.setContentSize(320,844);await pause(150);
    assert.equal(await evaluate('document.documentElement.scrollWidth'),await evaluate('innerWidth'),'320px layout must not overflow');
    window.setContentSize(390,844);await pause(150);
    await evaluate('document.querySelector(".fl-tr-take summary").focus()');
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});await pause(80);
    assert.equal(await evaluate('document.querySelector(".fl-tr-take details").open'),false,'details are keyboard operable');
    await evaluate('window.fixture.empty();window.scrollTo(0,0)');await waitFor('document.body.textContent.includes("No takes yet")');await capture('empty');
    report.events=await evaluate('window.fixture.events');assert.deepEqual(report.events.map(e=>e.kind),['inspect','select','export']);
    report.versions=process.versions;report.passed=true;console.log('NATIVE PASS');
  } catch(error) {report.passed=false;report.error=error.stack;console.error(error);if(window&&!window.isDestroyed())await capture('failure');process.exitCode=1;}
  finally {await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));if(window&&!window.isDestroyed())window.destroy();app.exit(report.passed?0:1);}
});
