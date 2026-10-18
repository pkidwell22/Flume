const { app, BrowserWindow, session, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pathToFileURL } = require('node:url');

const evidence = path.resolve(process.argv[2]);
const page = path.join(evidence, 'specimen', 'index.html');
const profile = path.resolve(process.argv[3]);
app.setPath('userData', path.join(profile, 'user'));
app.setPath('sessionData', path.join(profile, 'session'));
app.setActivationPolicy('accessory');
app.on('window-all-closed', () => {});
const report = { runId: process.argv[4], checks: [], screenshots: [], errors: [], blockedRequests: [] };
let window;
let exitCode = 0;
const delay = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => { assert.ok(condition, message); report.checks.push(message); };
const evaluate = (code) => window.webContents.executeJavaScript(code, true);
const key = async (keyCode) => {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await delay();
};
const capture = async (name) => {
  await delay(180);
  check(!window.isVisible(), `Hidden witness during ${name}`);
  const image = await window.webContents.capturePage(undefined, { stayHidden: true });
  check(!image.isEmpty(), `Nonempty render ${name}`);
  fs.writeFileSync(path.join(evidence, `${name}.png`), image.toPNG());
  report.screenshots.push(`${name}.png`);
};
const click = async (selector) => {
  const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await delay();
};

const watchdog = setTimeout(() => { console.error('Witness deadline exceeded'); app.exit(1); }, 75000);
app.whenReady().then(async () => {
  try {
    check(!app.isPackaged, 'Uses existing unpackaged Electron');
    const origin = pathToFileURL(path.dirname(page) + path.sep).href;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allow = details.url.startsWith(origin);
      if (!allow) report.blockedRequests.push(details.url);
      callback({ cancel: !allow });
    });
    nativeTheme.themeSource = 'light';
    window = new BrowserWindow({
      width: 1280, height: 1120, show: false, focusable: false,
      webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(pathToFileURL(page).href)) event.preventDefault(); });
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
    window.webContents.on('render-process-gone', (_event, details) => report.errors.push(details.reason));
    await window.loadFile(page);
    await evaluate('document.fonts.ready');
    // Hidden windows are not OS-active: emulate document focus for genuine
    // keyboard-driven :focus-visible matching, never force a CSS pseudo-state.
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    check(await evaluate('!!document.querySelector("#shot-title")'), 'Renders the real React component specimen');
    check(await evaluate('document.fonts.check(\'16px "Avenir Next"\')'), 'Installed Avenir Next resolves without font downloads');
    report.runtime = { electron: process.versions.electron, chromium: process.versions.chrome };
    report.desktop = await evaluate('({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, font: getComputedStyle(document.querySelector("#shot-title")).fontFamily })');
    check(report.desktop.documentWidth <= report.desktop.width, 'Desktop has no horizontal overflow');
    await capture('specimen-desktop');

    window.webContents.focus();
    await key('Tab');
    check(await evaluate('document.activeElement.matches("a.fl-brand")'), 'Tab reaches the native Brand link first');
    await key('Tab');
    report.tabAfterBrand = await evaluate('document.activeElement.id');
    check(report.tabAfterBrand === 'specimen-details', 'Tab follows DOM order through the details disclosure');
    await key('Tab');
    check(await evaluate('document.activeElement.id === "shot-title"'), 'Keyboard order moves to Shot title');
    report.focus = await evaluate('({ visible: document.activeElement.matches(":focus-visible"), width: getComputedStyle(document.activeElement).outlineWidth, style: getComputedStyle(document.activeElement).outlineStyle })');
    check(report.focus.visible && report.focus.width === '3px' && report.focus.style === 'solid', 'Keyboard focus is visibly outlined at 3px');
    await capture('specimen-keyboard-focus');
    await evaluate('document.querySelector("#shot-title").select()');
    window.webContents.insertText('Late afternoon study');
    await key('Tab');
    check(await evaluate('document.activeElement.id === "shot-prompt"'), 'Prompt follows title in keyboard order');
    await key('Tab');
    check(await evaluate('document.activeElement.id === "aspect-ratio"'), 'Native select is keyboard reachable');
    check(await evaluate('document.querySelector("#aspect-ratio").labels.length === 1'), 'Native select has an associated visible label');
    report.limitations = ['Native macOS select popup interaction/geometry is not verified in an invisible off-screen window.'];
    await evaluate(`(() => { const select = document.querySelector('#aspect-ratio'); select.value = '1:1'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await key('Tab');
    check(await evaluate('document.activeElement.id === "audio"'), 'Checkbox follows the native select');
    await key('Space');
    check(await evaluate('document.querySelector("#audio").checked'), 'Audio checkbox changes by keyboard');
    await key('Tab');
    check(await evaluate('document.activeElement.id === "save-example"'), 'Save example is next in keyboard order');
    await key('Space');
    check(await evaluate('document.querySelector("#aspect-ratio").value === "1:1"'), 'Select change event is retained through a React rerender');
    check(await evaluate('document.querySelector("#save-status").textContent.includes("Saved in this preview only")'), 'Saving reports local-only state, never provider success');
    check(await evaluate('document.querySelector("#saved-title").textContent === "Late afternoon study"'), 'Saved title is read back from component state');
    check(await evaluate('document.querySelector("#generate-example").disabled'), 'Generation remains explicitly unavailable');

    await click('#shot-title');
    await evaluate('document.querySelector("#shot-title").select()');
    window.webContents.insertText(' ');
    await click('#save-example');
    check(await evaluate('document.querySelector("#shot-title").getAttribute("aria-invalid") === "true"'), 'Empty title produces a semantic invalid field');
    check(await evaluate('document.querySelector("#title-error").textContent === "Enter a shot title."'), 'Invalid field has readable corrective text');
    check(await evaluate('document.activeElement.id === "shot-title"'), 'Validation returns focus to the field');
    await capture('specimen-validation');
    await evaluate('document.querySelector("#shot-title").select()');
    window.webContents.insertText('A'.repeat(160));
    await click('#save-example');
    check(await evaluate('document.querySelector("#saved-title").textContent.length === 160'), 'Long title is preserved without truncation');
    await click('#specimen-details');
    check(await evaluate('document.querySelector("details").open'), 'Native details disclosure opens');

    // Private, test-created renderer only; no remote debug flags/ports or user surface.
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    check(await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'), 'Reduced-motion preference is active in the witness');
    report.motion = await evaluate(`Array.from(document.querySelectorAll('.fl-theme *')).filter(e => { const s=getComputedStyle(e); return s.animationName !== 'none' || s.transitionDuration.split(',').some(v => parseFloat(v) > 0); }).length`);
    check(report.motion === 0, 'No animated or transitioning controls under reduced motion');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
    window.webContents.debugger.detach();

    window.setContentSize(390, 1120);
    await evaluate('scrollTo(0,0)');
    await delay(250);
    report.narrow = await evaluate(`({ width:innerWidth, documentWidth:document.documentElement.scrollWidth, title:document.querySelector('#saved-title').textContent, controls:Array.from(document.querySelectorAll('input:not([type=checkbox]),select,button,a.fl-brand')).map(e=>({id:e.id,height:e.getBoundingClientRect().height,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})) })`);
    report.overflow = await evaluate(`Array.from(document.querySelectorAll('.fl-specimen *')).filter(e => { const r=e.getBoundingClientRect(); return r.right > innerWidth + 1; }).map(e => ({tag:e.tagName, className:e.className, width:e.getBoundingClientRect().width, right:e.getBoundingClientRect().right}))`);
    check(report.narrow.documentWidth <= report.narrow.width, '390px viewport preserves long text without horizontal overflow');
    check(report.narrow.controls.every((control) => control.height >= 44 && control.left >= 0 && control.right <= report.narrow.width), 'Narrow controls fit and retain 44px minimum targets');
    await capture('specimen-narrow');
    await evaluate('document.querySelector("#mark-reductions").scrollIntoView({block:"start"})');
    await capture('specimen-mark-reductions');
    check(report.errors.length === 0, 'No renderer console errors');
    check(report.blockedRequests.length === 0, 'Specimen makes no outside requests');
  } catch (error) {
    exitCode = 1;
    report.failure = error.stack;
    console.error(error.stack);
    if (window && !window.isDestroyed()) await capture('specimen-failure').catch(() => {});
  } finally {
    clearTimeout(watchdog);
    if (window && !window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      window.destroy();
    }
    check(BrowserWindow.getAllWindows().length === 0, 'All owned witness windows closed');
    await session.defaultSession.closeAllConnections();
    fs.writeFileSync(path.join(evidence, 'render-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.exit(exitCode);
  }
});
