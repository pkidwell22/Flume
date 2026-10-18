import { useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Brand, FlumeMark } from '../index';
import '../theme.css';
import './specimen.css';

function Specimen() {
  const [title, setTitle] = useState('Window light');
  const [savedTitle, setSavedTitle] = useState('Window light');
  const [prompt, setPrompt] = useState('A slow move toward the window. Keep the light soft and the camera level.');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [audio, setAudio] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) {
      setError(true);
      setSaved(false);
      titleInput.current?.focus();
      return;
    }
    setError(false);
    setSavedTitle(title);
    setSaved(true);
  }

  return (
    <div className="fl-specimen">
      <header className="fl-specimen__header">
        <Brand href="#specimen" />
        <span className="fl-specimen__caption">Product primitives</span>
      </header>
      <main id="specimen">
        <div className="fl-specimen__intro">
          <h1>Component specimen</h1>
          <p>Local controls only. Nothing is uploaded or generated.</p>
        </div>
        <div className="fl-specimen__workbench">
          <section className="fl-specimen__preview" aria-labelledby="saved-title">
            <div className="fl-specimen__section-heading">
              <h2 id="saved-title">{savedTitle}</h2>
              <span className="fl-specimen__caption">Editable example</span>
            </div>
            <div className="fl-specimen__media">
              <div className="fl-specimen__empty-frame" aria-hidden="true" />
              <h3>No media loaded</h3>
              <p>Start with an image in the workspace.<br />This specimen does not contain a take.</p>
            </div>
            <div className="fl-specimen__frames">
              <div><span className="fl-ui-label">Start frame</span><span className="fl-ui-helper">Not set</span></div>
              <div><span className="fl-ui-label">End frame</span><span className="fl-ui-helper">Not set</span></div>
            </div>
            <details className="fl-ui-details">
              <summary id="specimen-details">Specimen details</summary>
              <p className="fl-ui-helper">No provider, account, project store or generation service is connected to this component preview. Changes reset on reload.</p>
              <p className="fl-specimen__identifier">example-local-shot-identifier-with-no-provider-or-account-authority</p>
            </details>
          </section>

          <section className="fl-specimen__controls" aria-labelledby="controls-heading">
            <h2 id="controls-heading">Shot controls</h2>
            <form noValidate onSubmit={save} onChange={() => setSaved(false)}>
              <div className="fl-ui-field">
                <label className="fl-ui-label" htmlFor="shot-title">Shot title</label>
                <input className="fl-ui-input" id="shot-title" ref={titleInput} value={title}
                  onChange={(event) => { setTitle(event.target.value); setError(false); }}
                  aria-invalid={error || undefined} aria-describedby={error ? 'title-error' : undefined} />
                {error && <p className="fl-ui-error" id="title-error">Enter a shot title.</p>}
              </div>
              <div className="fl-ui-field">
                <label className="fl-ui-label" htmlFor="shot-prompt">Prompt</label>
                <textarea className="fl-ui-input" id="shot-prompt" rows={3} value={prompt}
                  onChange={(event) => setPrompt(event.target.value)} />
              </div>
              <div className="fl-ui-field">
                <label className="fl-ui-label" htmlFor="aspect-ratio">Aspect ratio</label>
                <select className="fl-ui-input" id="aspect-ratio" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
                  <option value="16:9">16:9 — Landscape</option>
                  <option value="9:16">9:16 — Portrait</option>
                  <option value="1:1">1:1 — Square</option>
                </select>
              </div>
              <label className="fl-ui-check" htmlFor="audio">
                <input id="audio" type="checkbox" checked={audio} onChange={(event) => setAudio(event.target.checked)} />
                Generate audio
              </label>
              <div className="fl-specimen__actions">
                <button className="fl-ui-button fl-ui-button--primary" id="save-example" type="submit">Save example</button>
                <button className="fl-ui-button" id="generate-example" type="button" disabled aria-describedby="generation-blocker">Generate</button>
              </div>
              <p className="fl-ui-helper fl-specimen__save-status" role="status" id="save-status">{saved ? 'Saved in this preview only.' : 'Edits stay in this preview.'}</p>
              <div className="fl-ui-alert" id="generation-blocker">
                <span className="fl-ui-alert__title">Generation unavailable</span>
                <p>This specimen has no generation service. You can still edit the example.</p>
              </div>
            </form>
          </section>
        </div>

        <section className="fl-specimen__reference" id="mark-reductions" aria-labelledby="identity-heading">
          <div>
            <h2 id="identity-heading">One mark, at working sizes</h2>
            <div className="fl-specimen__reductions" aria-label="Flume mark at 58, 34 and 20 pixels">
              <figure className="fl-specimen__mark-large"><FlumeMark /><figcaption>58 px</figcaption></figure>
              <figure className="fl-specimen__mark-medium"><FlumeMark /><figcaption>34 px</figcaption></figure>
              <figure className="fl-specimen__mark-small"><FlumeMark /><figcaption>20 px</figcaption></figure>
            </div>
            <div className="fl-specimen__inverse"><Brand /><span>Reversed on ink</span></div>
          </div>
          <div className="fl-specimen__palette">
            <h2>Quiet surfaces. Clear controls.</h2>
            <dl>
              <div><dt><i className="fl-specimen__swatch fl-specimen__swatch--bone" />Bone</dt><dd>#EFE8D6</dd></div>
              <div><dt><i className="fl-specimen__swatch fl-specimen__swatch--ink" />Ink</dt><dd>#111111</dd></div>
              <div><dt><i className="fl-specimen__swatch fl-specimen__swatch--accent" />Action</dt><dd>#A52A27</dd></div>
            </dl>
            <p className="fl-ui-helper">Avenir Next with system fallbacks. Native controls, sentence-case labels and visible keyboard focus.</p>
          </div>
        </section>
      </main>
      <footer className="fl-specimen__footer">Flume UI specimen · Not the integrated workspace</footer>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing specimen root');
createRoot(root).render(<Specimen />);
