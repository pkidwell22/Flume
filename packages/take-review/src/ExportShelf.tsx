import React, {useEffect, useRef, useState} from 'react';
import {getTakeMedia, ownedMediaUrl} from './model';
import type {ReviewAsset, ReviewExport, ReviewShot, ReviewTake, TakeReviewProps} from './types';

type Props = TakeReviewProps & {shot: ReviewShot; actions: {active: string | null; run: (name: string, action: () => Promise<void>) => Promise<void>}};
export function ExportShelf({shot,takes,assets,exports:exportsIn,busy=false,onExport,actions}: Props) {
  const exports = exportsIn.filter(item => item.projectId === shot.projectId && item.shotId === shot.id);
  const selected = takes.find(take => take.id === shot.selectedTakeId);
  const canExport = !!selected && getTakeMedia(shot,selected,assets).status === 'ready';
  const [requested,setRequested] = useState(false);
  const [message,setMessage] = useState('');
  const requestBaseline = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (requested && exports.some(item => !requestBaseline.current?.has(item.id) && item.takeId === shot.selectedTakeId && item.shotRevision === shot.revision && item.selectionRevision === shot.selectionRevision)) {
      requestBaseline.current = null;
      setRequested(false); setMessage('');
    }
  }, [exportsIn, requested, shot]);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const current = exports.some(item => !isStale(item,shot) && item.status !== 'failed');
  const blocked = busy || actions.active !== null || !canExport || requested || current;
  const create = () => {
    if (blocked) return;
    void actions.run('export',async () => {
      requestBaseline.current = new Set(exports.map(item => item.id));
      setRequested(true); setMessage('');
      try {
        await onExport({projectId:shot.projectId,shotId:shot.id,expectedRevision:shot.revision,expectedSelectionRevision:shot.selectionRevision});
        if (mounted.current && requestBaseline.current !== null) setMessage('Export requested. Its status will appear after the workspace refreshes.');
      } catch {
        if (mounted.current && requestBaseline.current !== null) setMessage('Export could not be confirmed. Refresh the workspace before trying again.');
      }
    });
  };
  return <section className="fl-tr-exports" aria-label="Exports">
    <header className="fl-tr-heading"><div><h2>Export</h2><p>A frozen copy of the selected take. Later edits never replace it.</p></div>
      <button type="button" className="fl-tr-primary" onClick={create} disabled={blocked}>{actions.active === 'export' ? 'Requesting export…' : 'Export selected take'}</button>
    </header>
    {!shot.selectedTakeId ? <p className="fl-tr-hint">Select a take to enable export.</p> : !canExport ? <p className="fl-tr-hint">The selected take is unavailable. Refresh the workspace or select another owned take.</p> : current ? <p className="fl-tr-hint">The current selection already has an export below.</p> : null}
    {message && !current && <p role="status" className="fl-tr-feedback">{message}</p>}
    {exports.length === 0 ? <p className="fl-tr-empty-export">No exports yet. Export begins only when you ask.</p>
      : <div className="fl-tr-export-list">{exports.map(item => <ExportItem key={JSON.stringify([item.id,item.assetId])} item={item} shot={shot} takes={takes} assets={assets}/>)}</div>}
  </section>;
}

export function isStale(item: ReviewExport, shot: ReviewShot): boolean {
  return item.stale || item.shotRevision !== shot.revision || item.selectionRevision !== shot.selectionRevision || item.takeId !== shot.selectedTakeId;
}
function ExportItem({item,shot,takes,assets}: {item:ReviewExport;shot:ReviewShot;takes:readonly ReviewTake[];assets:readonly ReviewAsset[]}) {
  const output = assets.find(asset => asset.id === item.assetId && asset.projectId === item.projectId);
  const url = item.status === 'ready' && output?.kind === 'video' ? ownedMediaUrl(output) : null;
  const frozenTake = takes.find(take => take.id === item.takeId && take.projectId === item.projectId && take.shotId === item.shotId);
  const source = assets.find(asset => asset.id === frozenTake?.assetId && asset.projectId === item.projectId);
  const stale = isStale(item,shot);
  const [failed,setFailed] = useState(false);
  const [reload,setReload] = useState(0);
  const label = {queued:'Queued',running:'Exporting',ready: url && !failed ? 'Ready' : 'File unavailable',failed:'Export failed'}[item.status];
  return <article className="fl-tr-export" data-export-id={item.id}>
    <div className="fl-tr-export-summary">
      <div><h3>{label}</h3><p className="fl-tr-hint">Frozen at shot revision {item.shotRevision}, selection {item.selectionRevision}.</p></div>
      <div className="fl-tr-export-actions">{source && <span className="fl-tr-source">{{sample:'Sample',imported:'Imported',generated:'Generated'}[source.origin]}</span>}{stale && <span className="fl-tr-stale">Out of date</span>}
        {url && !failed && <a className="fl-tr-download" href={url} download={output?.filename || true}>Download frozen export</a>}
      </div>
    </div>
    {stale && <p className="fl-tr-hint">The shot or selection changed. This export keeps its original take; create a new export for the current selection.</p>}
    {item.status === 'queued' && <p className="fl-tr-hint">Waiting to export. No download is ready yet.</p>}
    {item.status === 'running' && <p className="fl-tr-hint">Creating the frozen file. No download is ready yet.</p>}
    {item.status === 'failed' && <p className="fl-tr-hint">The export did not finish. Your selected take is unchanged. Request a new export when ready.</p>}
    {item.status === 'ready' && (!url || failed) && <p className="fl-tr-hint">The owned export preview is unavailable. Reload the preview without creating a new export.</p>}
    {url && failed && <button type="button" onClick={()=>setReload(n=>n+1)}>Reload export preview</button>}
    {url && <details className="fl-tr-export-preview"><summary>Preview frozen export</summary><video key={reload} controls playsInline preload="metadata" src={reload ? `${url}?previewReload=${reload}` : url} aria-label="Preview frozen export" onLoadedData={()=>setFailed(false)} onError={()=>setFailed(true)}/></details>}
    <details className="fl-tr-details"><summary>Export details</summary><dl>
      <dt>Export</dt><dd>{item.id}</dd><dt>Frozen take</dt><dd>{item.takeId}</dd>
      <dt>Shot revision</dt><dd>{item.shotRevision}</dd><dt>Selection revision</dt><dd>{item.selectionRevision}</dd>
      <dt>Output asset</dt><dd>{item.assetId ?? 'Not available yet'}</dd>
      {output && <><dt>File</dt><dd>{output.filename}</dd><dt>SHA-256</dt><dd>{output.sha256}</dd></>}
    </dl></details>
  </article>;
}
