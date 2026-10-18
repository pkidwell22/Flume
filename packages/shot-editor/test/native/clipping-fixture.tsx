// Real components and shared hook, with geometry-only fixture controls.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useAnchoredPopup } from '../../src/useAnchoredPopup.ts';
import { ModelPicker } from '../../src/ModelPicker.tsx';
import { PromptComposer } from '../../src/PromptComposer.tsx';
import { capabilities } from '../fixtures.ts';
import '../../../ui/theme.css';
import '../../src/styles.css';
import '../../src/creator-controls.css';

let dismissals: number[] = [];
function Hook() {
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [version, setVersion] = useState(0);
  useAnchoredPopup(open, trigger, panel, () => { dismissals.push(version); setOpen(false); });
  Object.assign(window, { hook: { open: setOpen, version: setVersion } });
  return <><button type="button" id="hook-trigger" ref={trigger} onClick={() => setOpen(true)}>Hook trigger</button>
    {open && <div id="hook-panel" className="fl-anchored-popup" ref={panel} popover="manual"><div style={{ height: 300 }}>Geometry fixture popup</div></div>}</>;
}
function Fixture() {
  const [mode, setMode] = useState('hook'), [key, remount] = useState(0), [alive, setAlive] = useState(true);
  const [prompt, setPrompt] = useState('  Literal prompt.  '), [model, setModel] = useState('paired');
  Object.assign(window, { fixture: {
    reset: (next: string) => { setMode(next); remount(k => k + 1); setAlive(true); dismissals = []; },
    alive: setAlive, state: () => ({ dismissals, prompt, model }),
  } });
  return <><header>Isolated popup clipping fixture — no provider or application</header><button id="outside" type="button">Outside</button>
    <div id="scroller"><div id="canvas"><div id="stage"><div id="outer"><div id="clip"><div id="content" key={key}>
      {alive && (mode === 'hook' ? <Hook /> : <section id="component" className="fl-shot-editor">
        {mode === 'model' ? <ModelPicker value={model} capabilities={capabilities} onChange={setModel} /> : <PromptComposer value={prompt} onChange={setPrompt} />}
      </section>)}
    </div></div></div></div></div></div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
