const { app, BrowserWindow, session } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const output = process.argv[2];
if (!output) throw new Error('An owned evidence directory is required.');
for (const name of ['userData', 'sessionData']) { mkdirSync(join(output, name), { recursive: true }); app.setPath(name, join(output, name)); }
app.setActivationPolicy('accessory');
let server, window;
const checks = [];
const consoleErrors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Browser witness timed out'); app.exit(1); }, 75000);
const svg = end => `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><rect width="1600" height="1000" fill="#e6e7e3"/><path d="M0 720H1600V1000H0" fill="#d5d7d0"/><ellipse cx="800" cy="790" rx="350" ry="60" fill="#c3c5be"/><g transform="translate(${end ? 105 : -65} 0)"><path d="M${end ? 590 : 1030} 365c${end ? -240 : 240} -35 ${end ? -250 : 250} 350 0 300" fill="none" stroke="#8f302c" stroke-width="65"/><path d="M570 310h480l-25 390q-6 80-215 80t-215-80z" fill="#ae3c36"/><ellipse cx="810" cy="310" rx="240" ry="63" fill="#ce6861"/><ellipse cx="810" cy="308" rx="212" ry="43" fill="#702822"/><path d="M620 375l10 285q0 55 70 65" fill="none" stroke="#cc5e57" stroke-width="24" stroke-linecap="round"/></g></svg>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flume — activity and review component fixture</title><link rel="stylesheet" href="/fixture.css"><style>
:root{--fl-bg:#f3f3f0;--fl-surface:#fff;--fl-ink:#22221f;--fl-muted:#62625b;--fl-border:#d5d5cc;--fl-accent:#55584b;--fl-danger:#99362c;--fl-radius:5px;--fl-font:"Helvetica Neue",Helvetica,Arial,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--fl-bg);color:var(--fl-ink);font:15px/1.5 var(--fl-font)}.fixture-header{padding:24px 36px;display:flex;gap:32px;align-items:center;border-bottom:1px solid var(--fl-border);background:white}.fixture-header strong{font-size:28px;letter-spacing:-1px}.fixture-header span{font-size:13px;color:var(--fl-muted)}.fixture-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:64px;max-width:1280px;margin:auto;padding:40px}.fixture-layout>div{padding:28px;background:white}.fixture-preview{padding:20px 0}.fixture-preview h1{font-size:38px;font-weight:500;letter-spacing:-1.2px;margin:0 0 24px}.fixture-preview img{display:block;width:100%}.fixture-preview p{color:var(--fl-muted)}.fixture-preview button{font:inherit;padding:12px 18px;background:white;border:1px solid var(--fl-border);border-radius:5px;cursor:pointer}.fixture-preview button:focus-visible{outline:3px solid var(--fl-accent);outline-offset:3px}@media(max-width:600px){.fixture-header{padding:16px;align-items:flex-start;gap:20px}.fixture-layout{display:block;padding:16px}.fixture-layout>div{padding:16px}.fixture-preview{padding-top:32px}} </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`;

async function evaluate(code) { return window.webContents.executeJavaScript(code, true); }
async function until(code) { for (let i = 0; i < 100; i++) { if (await evaluate(code)) return; await delay(40); } throw new Error(`UI readiness timed out: ${code}`); }
async function capture(name) {
  await delay(120);
  assert.equal(window.isVisible(), false);
  const image = await window.webContents.capturePage(undefined, { stayHidden: true });
  assert.equal(image.isEmpty(), false);
  writeFileSync(join(output, `${name}.png`), image.toPNG());
}
async function noOverflow(label) {
  const geometry = await evaluate(`(() => {
    const d = document.querySelector('dialog[open]'); const root = d || document.documentElement;
    return { viewport: innerWidth, document: document.documentElement.scrollWidth, root: root.clientWidth, content: root.scrollWidth, children: d ? [...d.querySelectorAll('button,input,figure,dl')].map(e=>({tag:e.tagName,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})) : [] };
  })()`);
  await capture(label);
  assert.ok(geometry.document <= geometry.viewport + 1, JSON.stringify(geometry));
  assert.ok(geometry.content <= geometry.root + 1, JSON.stringify(geometry));
  assert.ok(geometry.children.every(e => e.left >= -1 && e.right <= geometry.viewport + 1), JSON.stringify(geometry));
  checks.push({ label, geometry });
}
async function clickText(text) { await evaluate(`(()=>{const b=[...document.querySelectorAll('dialog[open] button')].find(e=>e.textContent===${JSON.stringify(text)}); if(!b)throw Error('missing button'); b.click()})()`); await delay(60); }

app.whenReady().then(async () => {
  try {
    assert.equal(app.isPackaged, false);
    server = http.createServer((req, res) => {
      const routes = { '/': ['text/html', html], '/fixture.js': ['text/javascript', readFileSync(join(output, 'fixture.js'))], '/fixture.css': ['text/css', readFileSync(join(output, 'fixture.css'))], '/api/media/start': ['image/svg+xml', svg(false)], '/api/media/end': ['image/svg+xml', svg(true)] };
      const route = routes[req.url];
      if (!route) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': route[0], 'Cache-Control': 'no-store' }); res.end(route[1]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') }));
    window = new BrowserWindow({ width: 1440, height: 1120, show: false, focusable: false, webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(origin + '/')) event.preventDefault(); });
    window.webContents.on('console-message', details => { if (details.level === 'warning' || details.level === 'error') consoleErrors.push(details.message); });
    await window.loadURL(origin);
    await until(`!!document.querySelector('#open-review') && document.querySelector('.fixture-preview img').naturalWidth > 0`);
    await noOverflow('activity-desktop');
    await evaluate(`document.querySelector('#open-review').focus();document.querySelector('#open-review').click()`);
    await until(`!!document.querySelector('dialog[open]') && [...document.querySelectorAll('dialog img')].every(i=>i.naturalWidth>0) && !document.querySelector('.fl-review__warning')`);
    assert.equal(await evaluate(`document.activeElement.textContent`), 'Review generation');
    await noOverflow('review-desktop');
    await evaluate(`document.querySelector('.fl-review__content').scrollTop=10000`);
    await noOverflow('review-cost-desktop');
    assert.equal(await evaluate(`!!document.querySelector('dialog input')`), false, 'unknown cost must not solicit an unusable dollar cap');
    assert.equal(await evaluate(`[...document.querySelectorAll('.fl-review__actions button')].every(b=>b.disabled)`), true);
    assert.match(await evaluate(`document.querySelector('.fl-review__cost').textContent`), /approval is on hold/i);
    await evaluate(`window.fixture.approveReadback()`);
    await until(`document.querySelector('.fl-review__footer').textContent.includes('Approval confirmed')`);
    assert.equal(await evaluate(`document.querySelector('.fl-review__actions button:last-child').disabled`), true, 'unknown cost stays held after approval readback');
    assert.equal(await evaluate(`document.querySelector('#fixture-notice').textContent`), '');
    window.setContentSize(390, 844);
    await delay(150);
    await evaluate(`document.querySelector('.fl-review__cost').scrollIntoView({block:'center'})`);
    const holdGeometry = await evaluate(`(() => { const cost=document.querySelector('.fl-review__cost').getBoundingClientRect();const footer=document.querySelector('.fl-review__footer').getBoundingClientRect();return {top:cost.top,bottom:cost.bottom,footerTop:footer.top};})()`);
    assert.ok(holdGeometry.top >= 0 && holdGeometry.bottom <= holdGeometry.footerTop, JSON.stringify(holdGeometry));
    await noOverflow('unknown-cost-hold-mobile');
    checks.push({ label: 'unknown-cost-hold-including-approved-readback', passed: true });
    window.setContentSize(1440, 1120);
    await evaluate(`window.fixture.setReview({estimatedCostUsd:'0.800000',requestHash:'fixture-priced-review-hash'})`);
    await until(`!!document.querySelector('dialog input') && !document.querySelector('.fl-review__warning')`);
    await evaluate(`document.querySelector('.fl-review__content').scrollTop=10000`);
    for (const invalid of ['1.1234567', '1000000000']) {
      await evaluate(`document.querySelector('dialog input').focus();document.querySelector('dialog input').select()`);
      await window.webContents.insertText(invalid);
      await until(`document.querySelector('dialog input').getAttribute('aria-invalid')==='true'`);
      assert.equal(await evaluate(`document.querySelector('dialog input').value`), invalid);
      assert.equal(await evaluate(`document.querySelector('.fl-review__actions button').disabled`), true);
    }
    await evaluate(`document.querySelector('dialog input').focus();document.querySelector('dialog input').select()`);
    await window.webContents.insertText('2.500000');
    await until(`!document.querySelector('.fl-review__actions button').disabled`);
    await noOverflow('known-cost-precise-allowance');
    assert.match(await evaluate(`document.querySelector('.fl-review__cost').textContent`), /not a provider-enforced billing cap/i);
    await clickText('Approve this generation');
    assert.equal(await evaluate(`document.querySelector('#fixture-notice').textContent`), 'Approval callback: fixture-review; maxAttempts=1; maxCostUsd=2.500000');
    assert.equal(await evaluate(`document.querySelector('.fl-review__actions button:last-child').disabled`), true);
    await evaluate(`window.fixture.approveReadback()`);
    await until(`!document.querySelector('.fl-review__actions button:last-child').disabled`);
    await clickText('Generate once');
    assert.match(await evaluate(`document.querySelector('#fixture-notice').textContent`), /Submission callback: fixture-review/);
    assert.equal(await evaluate(`document.querySelector('.fl-review__actions button:last-child').disabled`), true);
    checks.push({ label: 'approval-and-submission-separate', passed: true });
    await clickText('Close');
    await until(`!document.querySelector('dialog')`);
    assert.equal(await evaluate(`document.activeElement.id`), 'open-review');
    await evaluate(`document.querySelector('#open-review').click()`);
    await until(`!!document.querySelector('dialog[open]')`);
    // Hidden windows suppress :focus-visible even while Tab changes activeElement.
    // Emulate focus only on this owned renderer; no debugging port or visible window.
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    assert.equal(await evaluate(`document.hasFocus()`), true);
    const keyboardFocus = [];
    for (let i = 0; i < 10; i++) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await delay(30);
      const focused = await evaluate(`({inside:!!document.activeElement.closest('dialog'), body:document.activeElement===document.body, outline:getComputedStyle(document.activeElement).outlineWidth})`);
      assert.ok(focused.inside || focused.body);
      keyboardFocus.push(focused);
    }
    writeFileSync(join(output, 'keyboard-focus.json'), JSON.stringify({ keyboardFocus, hasFocus: await evaluate(`document.hasFocus()`), active: await evaluate(`document.activeElement.outerHTML`) }, null, 2));
    assert.ok(keyboardFocus.some(item => item.inside && item.outline === '3px'), 'keyboard focus must have the visible component outline');
    await capture('review-keyboard-focus');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(`!document.querySelector('dialog')`);
    assert.equal(await evaluate(`document.activeElement.id`), 'open-review');
    checks.push({ label: 'native-modal-keyboard-and-focus-return', passed: true, keyboardFocus });
    await evaluate(`window.fixture.setReview({blockers:[{code:'zdr-violation-by-account',message:'Endpoint excluded'}]})`);
    await until(`!!document.querySelector('.fl-review__blockers')`);
    await evaluate(`document.querySelector('.fl-review__blockers').scrollIntoView({block:'center'})`);
    await noOverflow('review-privacy-block');
    assert.equal(await evaluate(`[...document.querySelectorAll('.fl-review__actions button')].every(b=>b.disabled)`), true);
    window.setContentSize(390, 844);
    await delay(200);
    await evaluate(`document.querySelector('.fl-review__content').scrollTop=0`);
    await noOverflow('review-mobile');
    await evaluate(`document.querySelector('.fl-review__content').scrollTop=10000`);
    await noOverflow('review-mobile-cost');
    await clickText('Close');
    await until(`!document.querySelector('dialog')`);
    await evaluate(`document.querySelectorAll('.fl-activity details')[0].open=true`);
    await noOverflow('activity-mobile');
    await evaluate(`window.fixture.setReview({id:'review-'+ 'x'.repeat(180), requestHash:'a'.repeat(256), controls:{modelId:'model/'+ 'x'.repeat(180),durationSeconds:5,resolution:'2K',aspectRatio:'16:9',generateAudio:false,seed:0}})`);
    await until(`!!document.querySelector('dialog[open]') && !document.querySelector('.fl-review__warning')`);
    await evaluate(`document.querySelector('.fl-review__details').open=true;document.querySelector('.fl-review__content').scrollTop=10000`);
    await noOverflow('review-mobile-long-identifiers');
    window.setContentSize(320, 720);
    await delay(200);
    await noOverflow('review-narrow-long-identifiers');
    await clickText('Close');
    await until(`!document.querySelector('dialog')`);
    await evaluate(`window.fixture.setAttempts([
      {id:'pending-receipt',projectId:'fixture-project',shotId:'shot',shotRevision:1,status:'running',providerJobId:null,errorCode:null,message:null},
      {id:'has-receipt',projectId:'fixture-project',shotId:'shot',shotRevision:1,status:'running',providerJobId:'Receipt-Case-SENSITIVE',errorCode:null,message:null},
      {id:'unknown-held',projectId:'fixture-project',shotId:'shot',shotRevision:1,status:'acceptance_unknown',providerJobId:null,errorCode:null,message:null}
    ])`);
    await until(`document.querySelectorAll('.fl-activity li').length===3`);
    const receiptStates = await evaluate(`[...document.querySelectorAll('.fl-activity li')].map(e=>({heading:e.querySelector('h3').textContent,text:e.textContent,buttons:e.querySelectorAll('button').length}))`);
    assert.deepEqual(receiptStates.map(state=>state.heading), ['Confirming submission', 'Awaiting result', 'Waiting for confirmation']);
    assert.deepEqual(receiptStates.map(state=>state.buttons), [0, 1, 0]);
    assert.match(receiptStates[0].text, /acceptance is not confirmed yet/i);
    assert.match(receiptStates[1].text, /provider accepted this attempt/i);
    assert.match(receiptStates[1].text, /execution and completion time are not confirmed/i);
    assert.match(receiptStates[2].text, /keep this attempt on hold; do not resubmit it/i);
    assert.doesNotMatch(receiptStates.map(state=>state.text).join(' '), /provider is working|\bgenerating\b|\d+%/i);
    window.setContentSize(390, 1000);
    await delay(150);
    await evaluate(`document.querySelector('.fl-activity').scrollIntoView({block:'start'})`);
    await noOverflow('receipt-aware-activity-mobile');
    checks.push({label:'receipt-aware-activity-without-invented-progress',passed:true,receiptStates});
    // Keep the fixture's long callback diagnostic out of unrelated layout checks.
    window.setContentSize(320, 720);
    await delay(150);
    await evaluate(`window.fixture.setAttempts([{id:'a'.repeat(256),projectId:'fixture-project',shotId:'s'.repeat(180),shotRevision:0,status:'acceptance_unknown',providerJobId:'receipt-'+ 'j'.repeat(180),errorCode:null,message:null}])`);
    await until(`document.querySelectorAll('.fl-activity li').length===1 && !!document.querySelector('.fl-activity button')`);
    await evaluate(`document.querySelector('.fl-activity details').open=true;document.querySelector('.fl-activity button').focus()`);
    await noOverflow('activity-narrow-long-identifiers');
    await evaluate(`document.querySelector('.fl-activity button').click()`);
    await until(`document.querySelector('#fixture-notice').textContent.startsWith('Recovery callback:')`);
    assert.equal(await evaluate(`document.querySelector('#fixture-notice').textContent`), `Recovery callback: ${'a'.repeat(256)}`);
    checks.push({label:'recovery-preserves-exact-attempt-identity',passed:true});
    assert.equal(consoleErrors.length, 0, JSON.stringify(consoleErrors));
    writeFileSync(join(output, 'browser-report.json'), JSON.stringify({ passed: true, electron: process.versions.electron, chromium: process.versions.chrome, isolated: true, liveProvider: false, ownership: { pid: process.pid, listener: server.address(), output }, checks, consoleErrors }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
  } catch (error) {
    if (window && !window.isDestroyed()) await capture('failure');
    writeFileSync(join(output, 'browser-report.json'), JSON.stringify({ passed: false, error: String(error.stack || error), checks, consoleErrors }, null, 2));
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) {
        await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
        window.webContents.debugger.detach();
      }
      window.destroy();
    }
    if (server) await new Promise(resolve => server.close(resolve));
    app.exit(process.exitCode || 0);
  }
});
