const $=id=>document.getElementById(id);
let state, firstLook, editorRevision, busy=false;
const inspections=new Map();
const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
function editorState(){
  const dirty=$('prompt').value!==state.prompt||editorRevision!==state.revision;
  $('approve').disabled=dirty||!state.canReview||!firstLook;
  $('submit').disabled=dirty;
  $('inspect-look').disabled=dirty;
  $('export').disabled=dirty||!state.selected_take;
}
$('prompt').addEventListener('input',()=>{if(state)editorState();});
function message(text,error=false){$('message').textContent=text;$('message').className=error?'error':'';}
async function api(url,body,headers={}){
  const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
}
async function act(action){if(busy)return;busy=true;try{await action();}catch(error){message(`${error.message}. The result may be unknown. Editor text is retained; check saved state before retrying.`,true);}finally{busy=false;}}
async function command(body){return api('/commands',{revision:state.revision,...body});}
function video(id){const v=node('video');v.controls=true;v.loop=true;v.playsInline=true;v.preload='metadata';v.src=`/media/${id}`;return v;}
function button(text,fn){const b=node('button',text);b.onclick=()=>act(fn);return b;}
async function refresh(loadDraft=true){
  const next=await api('/state');
  if(state&&state.revision!==next.revision){firstLook=null;inspections.clear();}
  state=next;if($('session'))$('session').hidden=true;$('workflow').hidden=false;
  if(loadDraft){$('prompt').value=state.prompt;editorRevision=state.revision;}
  $('revision').textContent=`Draft revision ${state.revision}`;
  editorState();
  $('look').src=`/media/${firstLook?.artifact||'first-look'}`;
  $('look-description').textContent=firstLook?.artifact&&firstLook.artifact!=='first-look'?'Actual imported fixture take. Review binds its artifact identity and bytes to this draft; it is not a live provider output.':'Prebuilt owned fixture preview, not a model response to your direction. Review binds these exact bytes to the current draft.';
  $('references').replaceChildren();
  for(const [name,binding] of [['First reference',state.continuity.first],['End reference',state.continuity.last]]){
    const f=node('figure');const image=node('img');image.src=`/media/${binding.image.path}`;image.alt=name;
    const d=binding.provenance.decoded;
    f.append(image,node('figcaption',`${name}: ${binding.role}
Source ${binding.provenance.source.fixture}, frame ${d.index}, PTS ${d.pts} × ${d.timeBase}
PNG ${binding.image.sha256}`));$('references').append(f);
  }
  $('takes').replaceChildren();
  for(const [i,take] of state.takes.entries()){
    const card=node('article');card.className=`take${state.selected_take===take.id?' selected':''}`;
    const hash=node('p',`Artifact ${take.sha256}`);hash.className='hash';
    card.append(node('h3',`Take ${i+1}${state.selected_take===take.id?' — selected':''}`),video(take.id),hash);
    const inspect=button('Inspect this take',async()=>{const r=await command({type:'inspect',artifact:take.id});inspections.set(take.id,r.id);firstLook=r;$('inspection').textContent=JSON.stringify(r,null,2);message(`Inspected take ${i+1}. No selection changed.`);await refresh(false);});
    const select=button('Select this take',async()=>{await command({type:'select',selectionRevision:state.selection_revision,takeId:take.id,inspectionId:inspections.get(take.id)});await refresh(false);message(`Take ${i+1} explicitly selected.`);});select.disabled=!inspections.has(take.id);
    const actions=node('div');actions.className='actions';actions.append(inspect,select);card.append(actions);$('takes').append(card);
  }
  if(!state.takes.length)$('takes').append(node('p','No takes received yet. Inspect the first look, approve the plan, then run the fixture.'));
  $('selection').textContent=state.selected_take?`Selection revision ${state.selection_revision}; take ${state.takes.findIndex(t=>t.id===state.selected_take)+1}`:'No take selected.';
  editorState();
  $('attempts').replaceChildren();
  for(const attempt of state.attempts){const row=node('div');row.append(node('p',`Run for draft ${attempt.revision}: ${attempt.available?'outputs ready':attempt.hold||attempt.remote_state}`));
    if(!attempt.available)row.append(button('Resume interrupted run',async()=>{await command({type:'recover',attemptId:attempt.id});message('Resuming the same attempt. Refresh to inspect its outputs.');await refresh(false);}));$('attempts').append(row);}
  $('exports').replaceChildren();
  for(const exp of state.exports){const row=node('div');row.className='export';row.append(node('p',`Draft ${exp.revision}, selection ${exp.selection_revision}: ${exp.status}${exp.stale?' — stale; frozen inputs retained':''}`));
    if(exp.status==='complete'){const a=node('a','View frozen export');a.href=`/media/export-${exp.id}`;a.target='_blank';a.rel='noopener';row.append(a);} $('exports').append(row);}
}
if($('login'))$('login').onsubmit=event=>{event.preventDefault();act(async()=>{await api('/session',{}, {authorization:`Bearer ${$('key').value.trim()}`});$('key').value='';await refresh();message('Local review opened.');});};
$('edit').onsubmit=event=>{event.preventDefault();return act(async()=>{const saved=await command({type:'edit',revision:editorRevision,prompt:$('prompt').value});editorRevision=saved.revision;firstLook=null;inspections.clear();await refresh(false);message($('prompt').value===saved.prompt?'Draft saved. Previous approval is no longer valid.':'Submitted draft saved; newer editor text is still unsaved.');});};
$('refresh').onclick=()=>act(async()=>{await refresh();message('Loaded the current saved draft.');});
$('inspect-look').onclick=()=>act(async()=>{firstLook=await command({type:'inspect',artifact:'first-look'});$('inspection').textContent=JSON.stringify(firstLook,null,2);await refresh(false);message('Exact fixture bytes inspected for this draft. Approval is still separate.');});
$('approve').onclick=()=>act(async()=>{await command({type:'approve',inspectionId:firstLook.id});message('Plan approved for one local fixture attempt; no money or upload authority exists.');});
$('submit').onclick=()=>act(async()=>{await command({type:'submit',commandId:crypto.randomUUID()});message('Local run accepted. Refresh to see results; nothing will be selected automatically.');await refresh(false);});
$('export').onclick=()=>act(async()=>{await command({type:'export',selectionRevision:state.selection_revision});message('Export inputs frozen. Refresh to view the completed file.');await refresh(false);});
refresh().catch(()=>message($('login')?'Open a local review session to continue.':'Unable to load the local fixture. Reload to retry.',true));
