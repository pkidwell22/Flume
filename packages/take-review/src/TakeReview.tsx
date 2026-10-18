import React, {useEffect, useRef, useState} from 'react';
import {getTakeMedia} from './model';
import {ExportShelf} from './ExportShelf';
import type {ReviewAsset, ReviewShot, ReviewTake, TakeReviewProps} from './types';

/** Selection is controlled by shot.selectedTakeId, never by take arrival or playback. */
export function TakeReview(props: TakeReviewProps) {
  if (!props.shot) return <section className="fl-take-review" aria-label="Takes">
    <h2>Takes</h2><div className="fl-tr-empty"><h3>Choose a shot</h3><p>Open or create a shot to review its takes.</p></div>
  </section>;
  const shot = props.shot;
  // A receipt from an older editorial snapshot must never authorize this one.
  const scope = JSON.stringify([shot.projectId, shot.id]);
  return <ShotTakes key={scope} {...props} shot={shot}/>;
}

type ShotProps = TakeReviewProps & {shot: ReviewShot};
type Actions = {active: string | null; run: (name: string, action: () => Promise<void>) => Promise<void>};
function useActions(busy: boolean): Actions {
  const [active, setActive] = useState<string | null>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return {active, async run(name, action) {
    if (busy || lock.current) return;
    lock.current = true; setActive(name);
    try { await action(); }
    finally { lock.current = false; if (mounted.current) setActive(null); }
  }};
}

function ShotTakes(props: ShotProps) {
  const {shot, assets, busy = false} = props;
  const takes = props.takes.filter(take => take.projectId === shot.projectId && take.shotId === shot.id);
  const actions = useActions(busy);
  return <section className="fl-take-review" aria-label="Takes">
    <header className="fl-tr-heading"><div><h2>Takes</h2><p>Play, inspect, then select. The choice is yours.</p></div>
      <p className="fl-tr-selection">{shot.selectedTakeId ? 'One take selected' : 'No take selected'}</p>
    </header>
    {takes.length === 0 ? <div className="fl-tr-empty"><h3>No takes yet</h3><p>Generate a take from the shot editor, then compare it here. New takes are never selected automatically.</p></div>
      : <div className="fl-tr-comparison">{takes.map((take, index) => {
        const asset = assets.find(item => item.id === take.assetId && item.projectId === shot.projectId);
        const identity = JSON.stringify([take.id, take.assetId, asset?.sha256, asset?.mediaUrl, asset?.kind]);
        return <TakeCard key={identity} {...props} take={take} number={index + 1} actions={actions}/>;
      })}</div>}
    <ExportShelf {...props} actions={actions}/>
  </section>;
}

type CardProps = ShotProps & {take: ReviewTake; number: number; actions: Actions};
function TakeCard({shot,take,number,assets,busy=false,onInspect,onSelect,actions}: CardProps) {
  const media = getTakeMedia(shot,take,assets);
  const asset = media.status === 'ready' ? media.asset : assets.find(item => item.id === take.assetId && item.projectId === shot.projectId);
  const [loaded,setLoaded] = useState(false);
  const [played,setPlayed] = useState(false);
  const [failed,setFailed] = useState(false);
  const [inspection,setInspection] = useState<{id:string;scope:string} | null>(null);
  const scope = JSON.stringify([shot.revision,shot.selectionRevision]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const validInspection = inspection?.scope === scope ? inspection.id : null;
  const [reload,setReload] = useState(0);
  const playbackEpoch = useRef(0);
  const [message,setMessage] = useState('');
  const [selectRequested,setSelectRequested] = useState(false);
  const selectButton=useRef<HTMLButtonElement>(null);
  const selectionFocus=useRef<{scope:string;restore:()=>void;cancel:()=>void} | null>(null);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;selectionFocus.current?.cancel();};}, []);
  const selected = shot.selectedTakeId === take.id;
  useEffect(()=>{setInspection(null);setSelectRequested(false);setMessage('');playbackEpoch.current++;},[scope]);
  const blocked = busy || actions.active !== null;
  useEffect(()=>{
    const claim=selectionFocus.current;
    // A superseding unselected readback retires this request, even while busy.
    if(claim && claim.scope!==scope && !selected) claim.cancel();
    else if(selected&&!blocked) claim?.restore();
  },[scope,selected,blocked]);
  const canInspect = media.status === 'ready' && loaded && played && !failed;
  const invalidatePlayback = () => {
    playbackEpoch.current++;setLoaded(false);setPlayed(false);setInspection(null);
  };
  const inspect = () => {
    if (!canInspect || blocked || validInspection) return;
    void actions.run(`inspect:${take.id}`, async () => {
      setMessage('');
      const observedPlayback = playbackEpoch.current, observedScope = scope;
      try {
        const receipt = await onInspect({projectId:shot.projectId,takeId:take.id});
        if (!receipt?.inspectionId || !receipt.inspectionId.trim()) throw new Error('No inspection receipt');
        if (mounted.current && observedPlayback === playbackEpoch.current && observedScope === currentScope.current) setInspection({id:receipt.inspectionId,scope:observedScope});
      } catch {
        if (mounted.current && observedPlayback === playbackEpoch.current && observedScope === currentScope.current) setMessage('Inspection could not be confirmed. Try inspecting this take again.');
      }
    });
  };
  const select = () => {
    if (!canInspect || !validInspection || selected || blocked || selectRequested) return;
    void actions.run(`select:${take.id}`, async () => {
      const requestedScope=scope;
      selectionFocus.current?.cancel();
      const button=selectButton.current;
      if(button && button.ownerDocument.activeElement===button) {
        const document=button.ownerDocument;
        let lostToDisabled=false;
        const cancel=()=>{
          button.removeEventListener('blur',onBlur);
          document.removeEventListener('focusin',onFocus,true);
          document.removeEventListener('pointerdown',cancel,true);
          selectionFocus.current=null;
        };
        const onBlur=()=>{if(button.disabled) lostToDisabled=true;else cancel();};
        const onFocus=(event:FocusEvent)=>{if(event.target!==button) cancel();};
        // Only recover a disabled-control blur, never a newer user destination.
        selectionFocus.current={scope:requestedScope,cancel,restore:()=>{
          const restore=lostToDisabled && document.activeElement===document.body;
          cancel();
          if(restore && button.isConnected) button.focus({preventScroll:true});
        }};
        button.addEventListener('blur',onBlur);
        document.addEventListener('focusin',onFocus,true);
        document.addEventListener('pointerdown',cancel,true);
      }
      setMessage(''); setSelectRequested(true);
      try {
        await onSelect({projectId:shot.projectId,shotId:shot.id,takeId:take.id,inspectionId:validInspection,expectedRevision:shot.revision,expectedSelectionRevision:shot.selectionRevision});
        if (mounted.current && currentScope.current===requestedScope) setMessage('Selection requested. Waiting for the workspace to refresh.');
      } catch {
        if (mounted.current) setMessage('Selection could not be confirmed. Refresh the workspace before trying again.');
      }
    });
  };
  return <article className="fl-tr-take" data-take-id={take.id} aria-label={`Take ${number}`} data-selected={selected}>
    <header className="fl-tr-card-heading"><h3>Take {number}</h3>{asset && <span className="fl-tr-source">{sourceLabel(asset)}</span>}</header>
    <div className="fl-tr-screen">
      {media.status === 'ready' ? <video key={reload} controls playsInline preload="metadata" src={reload ? `${media.url}?previewReload=${reload}` : media.url} aria-label={`Preview take ${number}`}
        onLoadedData={()=>{setLoaded(true);setFailed(false);}} onPlaying={()=>setPlayed(true)}
        onEmptied={invalidatePlayback}
        onError={()=>{invalidatePlayback();setFailed(true);}}/>
        : <div className="fl-tr-unavailable"><strong>Video unavailable</strong><p>{media.reason}</p></div>}
    </div>
    <div className="fl-tr-card-body">
      {asset && <p className="fl-tr-media-meta">{asset.width} × {asset.height}{asset.durationSeconds !== undefined ? ` / ${asset.durationSeconds} s` : ''}</p>}
      <p className="fl-tr-hint">{failed ? 'Playback unavailable. Reload this preview, then play and inspect it again.' : media.status !== 'ready' ? 'Selection requires an owned video you can play.' : selected ? 'Selected for this shot. Export a frozen copy below.' : validInspection ? 'Inspection recorded. Select this take when you are ready.' : 'Play this take, then inspect it to enable selection.'}</p>
      {/* Retry the owned resource; only decoded data clears failure, never command holds. */}
      {failed && <button type="button" onClick={()=>{invalidatePlayback();setReload(n=>n+1);}}>Reload take preview</button>}
      <div className="fl-tr-actions">
        <button type="button" onClick={inspect} disabled={blocked || !canInspect || !!validInspection}>{actions.active === `inspect:${take.id}` ? 'Inspecting…' : validInspection ? 'Inspected' : 'Inspect take'}</button>
        <button ref={selectButton} type="button" className="fl-tr-primary" aria-pressed={selected} onClick={select} disabled={!selected && (blocked || !canInspect || !validInspection || selectRequested)} aria-disabled={selected || undefined}>{selected ? 'Selected' : actions.active === `select:${take.id}` ? 'Selecting…' : 'Select take'}</button>
      </div>
      {message && <p role="status" className="fl-tr-feedback">{message}</p>}
      <details className="fl-tr-details"><summary>Take details</summary><dl>
        <dt>Take</dt><dd>{take.id}</dd><dt>Attempt</dt><dd>{take.attemptId}</dd><dt>Created</dt><dd>{take.createdAt}</dd>
        <dt>Asset</dt><dd>{take.assetId}</dd>
        {asset && <><dt>File</dt><dd>{asset.filename}</dd><dt>Source</dt><dd>{sourceLabel(asset)}</dd><dt>SHA-256</dt><dd>{asset.sha256}</dd></>}
      </dl></details>
    </div>
  </article>;
}
function sourceLabel(asset: ReviewAsset) { return {sample:'Sample',imported:'Imported',generated:'Generated'}[asset.origin]; }
