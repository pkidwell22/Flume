import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

test('chat panel aborts the real stream signal when unmounted', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:4310' }); Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const React = await import('react'), { createRoot } = await import('react-dom/client'), { fireEvent } = await import('@testing-library/react'), { ChatPanel } = await import('../src/ChatPanel.tsx');
  let observed: AbortSignal | undefined;
  const conversation = { id: '10000000-0000-4000-8000-000000000010', projectId: '10000000-0000-4000-8000-000000000001', title: 'Scene', modelId: 'google/gemini-2.5-flash-lite', messages: [] };
  const port: any = { models: async () => ['google/gemini-2.5-flash-lite'], list: async () => [conversation], create: async () => conversation, rename: async () => conversation, stream: async (_input: unknown, signal: AbortSignal) => { observed = signal; await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); } };
  const root = createRoot(document.getElementById('root')!); await React.act(async () => root.render(<ChatPanel port={port} project={{ id: conversation.projectId, name: 'Film' }} dirty={false} assets={[]} />)); await React.act(async () => {});
  await React.act(async () => { fireEvent.change(document.querySelector('textarea')!, { target: { value: 'Hello' } }); });
  const send = [...document.querySelectorAll('button')].find(button => button.textContent === 'Send') as HTMLButtonElement; assert.equal(send.disabled, false); await React.act(async () => { send.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.ok(observed); await React.act(async () => root.unmount()); assert.equal(observed.aborted, true); dom.window.close();
});
