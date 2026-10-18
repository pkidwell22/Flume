import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ShotEditor } from '../../src/ShotEditor.tsx';
import { ModelPicker } from '../../src/ModelPicker.tsx';
import { PromptComposer } from '../../src/PromptComposer.tsx';
import { shot, capabilities } from '../fixtures.ts';
import '../../../ui/theme.css';
import '../../src/styles.css';
import '../../src/creator-controls.css';
import '../../../../apps/web/src/workspace.css';

const literalId = '  fixture/Mixed-ID  ';
const catalog = [capabilities[0]!, { ...capabilities[1]!, modelId: literalId },
  ...Array.from({ length: 12 }, (_, i) => ({ ...capabilities[0]!, modelId: `fixture/${i}`, name: `Fixture model ${i}` }))];
const events = { dirty: [] as boolean[], saves: [] as unknown[], prepares: [] as unknown[] };
let sequence = 0;
function Fixture() {
  const [busy, lock] = useState(false);
  const [key, remount] = useState(0);
  const [direct, setDirect] = useState(false);
  const [modelId, setModelId] = useState('paired');
  const [prompt, replace] = useState('  Literal prompt\r\nwith an untouched ending.  ');
  Object.assign(window, { fixture: {
    lock,
    replace,
    reset: (componentsOnly = false) => { setDirect(componentsOnly); setModelId('paired'); lock(false); replace('  Literal prompt\r\nwith an untouched ending.  '); remount(++sequence); events.dirty.length = events.saves.length = events.prepares.length = 0; },
    state: () => ({ ...events, literalId }),
  } });
  return <>
    <header id="witness-label">Isolated creator popup test fixture — no provider, account or requests</header>
    <button id="outside" type="button">Outside focus target</button>
    <div id="nonfocus">Outside surface</div>
    <div id="scroller"><div id="canvas"><main id="stage">
      <button id="before" type="button">Before editor</button>
      {direct ? <section key={key} className="fl-shot-editor">
        <PromptComposer value={prompt} onChange={replace} disabled={busy} />
        <ModelPicker value={modelId} onChange={setModelId} capabilities={catalog} disabled={busy} />
      </section> : <ShotEditor key={key} shot={{ ...shot, prompt }} assets={[]} capabilities={catalog} busy={busy}
        onSave={async request => { events.saves.push(request); return { revision: 4 }; }}
        onUpload={async () => { throw new Error('Imports are not part of this fixture'); }}
        onPrepare={async request => { events.prepares.push(request); }}
        onDirtyChange={value => { events.dirty.push(value); }} />}
      <button id="after" type="button">After editor</button>
    </main></div></div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
