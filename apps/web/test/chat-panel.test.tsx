import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ChatPanel, type ChatPort } from '../src/ChatPanel.tsx';

test('chat panel opens without sending, renders transcript as text, and discloses saved context', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:4310' }); Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  let sends = 0;
  const port: ChatPort = { models: async () => ['google/gemini-2.5-flash-lite'], list: async () => [{ id: '10000000-0000-4000-8000-000000000010', projectId: '10000000-0000-4000-8000-000000000001', title: 'Scene', modelId: 'google/gemini-2.5-flash-lite', messages: [{ id: '10000000-0000-4000-8000-000000000011', role: 'assistant', status: 'completed', content: '<img src=x onerror=alert(1)>', usage: null }] }], create: async () => { throw Error('unused'); }, rename: async () => { throw Error('unused'); }, stream: async () => { sends++; }, propose: async () => { throw Error('unused'); }, applyProposal: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); } };
  const root = createRoot(document.getElementById('root')!); await act(async () => root.render(<ChatPanel port={port} project={{ id: '10000000-0000-4000-8000-000000000001', name: 'Film' }} shot={{ id: '10000000-0000-4000-8000-000000000002', title: 'Door', revision: 3 }} dirty={true} assets={[]} />)); await act(async () => {});
  assert.match(document.body.textContent ?? '', /Context for next message/); assert.equal(sends, 0); assert.equal(document.querySelector('img'), null); assert.match(document.body.textContent ?? '', /<img src=x/); assert.match(document.body.textContent ?? '', /saved revision 3/i); assert.match(document.body.textContent ?? '', /unsaved draft is not included/i);
  await act(async () => root.unmount()); dom.window.close();
});
