import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
// jsdom applies the UA hidden-popover rule but has no top-layer API. This
// adapter exposes mounted popovers to DOM assertions; geometry, native focus,
// pointer dismissal and the real top layer are verified in test/native/.
Object.defineProperty(dom.window.HTMLElement.prototype, 'showPopover', {
  configurable: true,
  value(this: HTMLElement) { this.style.display = 'block'; },
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Event',
  'File',
  'FileList',
  'Blob',
  'Node',
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[key],
  });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
