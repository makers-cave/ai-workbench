async function load(){
 const r=await fetch('/api/tools'); const data=await r.json();
 document.getElementById('grid').innerHTML=data.map(t=>{
   const s=t.status.state, url=t.url||'';
   const open=(s==='running' && url)?`<a class="btn" href="${url}" target="_blank" rel="noopener">Open</a>`:'';
   const isStarting = s==='starting' || (t.background_task && t.background_task.status === 'running');
   const toggle=t.kind==='docker'
    ? `<button onclick="act('${t._id}','${s==='running'?'disable':'enable'}')" ${isStarting?'disabled':''}>${isStarting?'Building...':(s==='running'?'Disable':'Enable')}</button>`
    : '';
   const iconUrl=t.icon?(t.icon.startsWith('http')?t.icon:`/api/tools/${t._id}/icon`):'';
   return `<section class="card"><div class="row">${iconUrl?`<img class="icon" src="${iconUrl}" alt="">`:''}<h2>${t.name}</h2><span class="badge ${s}">${s}</span></div>
   <p class="muted">${t.description||''}</p><div>${t.notes||''}</div>${isStarting ? `<div style="color:#ff8c42;font-size:13px;margin-top:8px;">⏳ Build in progress (${t.background_task ? t.background_task.duration : '?'}s)</div>` : ''}
   <div class="actions">${toggle}${open}</div></section>`;
 }).join('');
}
// --- Log sidebar ---
const sidebar=document.getElementById('sidebar');
const logEl=document.getElementById('log');
// The pulse dot moved from #log-dot (inside the sidebar head) to inside the
// header button (#log-toggle .sidebar-dot). Look it up by querySelector so
// the existing logDot.classList.add('busy') calls keep working.
const logDot=document.querySelector('#log-toggle .sidebar-dot') || document.getElementById('log-dot');
const logToggle=document.getElementById('log-toggle');
const logClose=document.getElementById('log-close');
let autoCollapse=false;
let activeTasks=0;

function expandSidebar(){
 sidebar.classList.add('open');
 sidebar.setAttribute('aria-hidden','false');
 logToggle.classList.add('hidden');
}
function collapseSidebar(){
 sidebar.classList.remove('open');
 sidebar.setAttribute('aria-hidden','true');
 logToggle.classList.remove('hidden');
}
logToggle.addEventListener('click',()=>{ autoCollapse=false; expandSidebar(); });
logClose.addEventListener('click',()=>{ autoCollapse=false; collapseSidebar(); });

// --- Settings overlay (tabbed: General + Tools) ---
const settingsOverlay=document.getElementById('settings-overlay');
const settingsToggle=document.getElementById('settings-toggle');
const settingsClose=document.getElementById('settings-close');
const settingsSave=document.getElementById('settings-save');
const settingsReset=document.getElementById('settings-reset');
const settingsStatus=document.getElementById('settings-status');
const tabGeneral=document.getElementById('tab-general');
const tabTools=document.getElementById('tab-tools');
const paneGeneral=document.getElementById('pane-general');
const paneTools=document.getElementById('pane-tools');
const settingTheme=document.getElementById('setting-theme');
const settingHost=document.getElementById('setting-host');
const settingPort=document.getElementById('setting-port');
const settingRefresh=document.getElementById('setting-refresh');
const toolAddBtn=document.getElementById('tool-add-btn');
const toolAddFile=document.getElementById('tool-add-file');
const toolAddStatus=document.getElementById('tool-add-status');
const toolReviewSection=document.getElementById('tool-review-section');
const toolReviewId=document.getElementById('tool-review-id');
const toolReviewName=document.getElementById('tool-review-name');
const toolReviewKind=document.getElementById('tool-review-kind');
const toolReviewUrl=document.getElementById('tool-review-url');
const toolReviewDescription=document.getElementById('tool-review-description');
const toolReviewIcon=document.getElementById('tool-review-icon');
const toolReviewNotes=document.getElementById('tool-review-notes');
const toolReviewFilesList=document.getElementById('tool-review-files-list');
const toolReviewWarnings=document.getElementById('tool-review-warnings');
const toolReviewWarningsList=document.getElementById('tool-review-warnings-list');
const toolReviewOverwrite=document.getElementById('tool-review-overwrite');
const toolReviewOverwriteId=document.getElementById('tool-review-overwrite-id');
const toolReviewCancel=document.getElementById('tool-review-cancel');
const toolReviewInstall=document.getElementById('tool-review-install');
const toolReviewOverwriteBtn=document.getElementById('tool-review-overwrite-btn');
const toolsList=document.getElementById('tools-list');
const toolsEmpty=document.getElementById('tools-empty');
const toolsRefresh=document.getElementById('tools-refresh');
const toolsCategories=document.getElementById('tools-categories');

// localStorage is now only used as a quick theme cache; server is authoritative.
const LS_THEME_KEY='ai-workbench-theme';
const DEFAULT_UI={theme:'dark',host:'',port:'',refresh:5};
const ID_RE=/^[a-z0-9][a-z0-9_-]{0,39}$/;

// HALO STIX tool taxonomy. Order = display order. Tools not in the map fall
// into the "Other" bucket at the end. AnythingLLM is duplicated in the source
// taxonomy (AI Chat + Knowledge/RAG); we keep it under Knowledge / RAG as
// that's the more specific (and accurate) home for it.
const CATEGORIES=[
 {id:'ai-runtimes',   name:'AI Runtimes',         icon:'\u{1F9E0}'},
 {id:'ai-chat',       name:'AI Chat',             icon:'\u{1F4AC}'},
 {id:'ai-agents',     name:'AI Agents',           icon:'\u{1F916}'},
 {id:'coding',        name:'Coding',              icon:'\u{1F468}\u{200D}\u{1F4BB}'},
 {id:'automation',    name:'Automation',          icon:'\u{1F504}'},
 {id:'knowledge',     name:'Knowledge / RAG',     icon:'\u{1F4DA}'},
 {id:'image',         name:'Image',               icon:'\u{1F3A8}'},
 {id:'video',         name:'Video',               icon:'\u{1F3AC}'},
 {id:'voice',         name:'Voice',               icon:'\u{1F399}'},
 {id:'audio',         name:'Audio',               icon:'\u{1F3B5}'},
 {id:'documents',     name:'Documents',           icon:'\u{1F4C4}'},
 {id:'search',        name:'AI Search',           icon:'\u{1F310}'},
 {id:'3d',            name:'3D',                  icon:'\u{1F9CA}'},
 {id:'observability', name:'Observability',       icon:'\u{1F4C8}'},
 {id:'infra',         name:'Infrastructure',      icon:'\u2699\uFE0F'},
 {id:'other',         name:'Other',               icon:'\u{1F4E6}'},
];
const CATEGORY_BY_ID=Object.fromEntries(CATEGORIES.map(c=>[c.id,c]));

// Each entry: [categoryId, [tool folder ids...]].
// Folder ids are the tool _id values (e.g. "openwebui", "comfyui").
// Local fallback map for installed tools that are NOT in data/repo.json.
// The authoritative category for every tool now lives in data/repo.json
// (fetched at runtime via /api/repo). This map only acts as a last-resort
// hint when the catalog is unreachable, so legacy installations still group
// into the right accordion.
const FALLBACK_TOOL_CAT={
 'llama-cpp':'ai-runtimes','llama.cpp':'ai-runtimes',
 'open-webui':'ai-chat','openwebui':'ai-chat','webui':'ai-chat',
 'comfyui':'image','invokeai':'image','invoke-ai':'image','stable-diffusion':'image',
 'n8n':'automation',
 'openhands':'ai-agents',
};
function categoryForToolId(id){
 if(!id) return 'other';
 return FALLBACK_TOOL_CAT[String(id).toLowerCase()] || 'other';
}

let serverSettings={added_tools:[],ui:{...DEFAULT_UI}};
let activeTab='general';

function applyTheme(theme){
 document.documentElement.dataset.theme=theme||'dark';
 try{ localStorage.setItem(LS_THEME_KEY,theme||'dark'); }catch(e){}
}

function setStatus(msg,kind){
 if(!settingsStatus) return;
 settingsStatus.textContent=msg||'';
 settingsStatus.classList.remove('ok','error');
 if(kind) settingsStatus.classList.add(kind);
 if(msg){
  clearTimeout(setStatus._t);
  setStatus._t=setTimeout(()=>{ settingsStatus.textContent=''; settingsStatus.classList.remove('ok','error'); },4500);
 }
}

function selectTab(name){
 activeTab=(name==='tools')?'tools':'general';
 const tabs=[tabGeneral,tabTools];
 const panes=[paneGeneral,paneTools];
 tabs.forEach((t,i)=>{
  const on=t.dataset.tab===activeTab;
  t.setAttribute('aria-selected',on?'true':'false');
  t.tabIndex=on?0:-1;
  panes[i].hidden=!on;
 });
 try{ sessionStorage.setItem('ai-workbench-settings-tab',activeTab); }catch(e){}
}

tabGeneral.addEventListener('click',()=>selectTab('general'));
tabTools.addEventListener('click',()=>selectTab('tools'));
// Keyboard arrow navigation between tabs
[tabGeneral,tabTools].forEach((t,i,arr)=>{
 t.addEventListener('keydown',e=>{
  if(e.key!=='ArrowDown' && e.key!=='ArrowUp' && e.key!=='ArrowRight' && e.key!=='ArrowLeft') return;
  e.preventDefault();
  const next=arr[(i+1)%arr.length];
  selectTab(next.dataset.tab);
  next.focus();
 });
});

function populateGeneralFromSettings(){
 const ui=serverSettings.ui||{};
 settingTheme.value=ui.theme||'dark';
 settingHost.value=ui.host||'';
 settingPort.value=ui.port||'';
 settingRefresh.value=ui.refresh||5;
}

const ESC_MAP={'&':'&'+'amp;','<':'&'+'lt;','>':'&'+'gt;','"':'&'+'quot;',"'":'&#'+'39;'};
function escapeHtml(s){
 return String(s==null?'':s).replace(/[&<>"']/g,c=>ESC_MAP[c]);
}

function statusBadgeFor(t){
 const s=(t.status&&t.status.state)||'unknown';
 const map={running:'running',stopped:'stopped',starting:'starting',error:'error',external:'external'};
 const cls=map[s]||'stopped';
 const label=s;
 return `<span class="tool-status ${cls}">${label}</span>`;
}

function iconFor(t){
 const u=t.icon?(t.icon.startsWith('http')?t.icon:`/api/tools/${t._id}/icon`):'';
 if(u) return `<div class="tool-icon"><img src="${u}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'placeholder',textContent:'${escapeHtml((t.name||t._id||'?').charAt(0).toUpperCase())}))"></div>`;
 const letter=(t.name||t._id||'?').charAt(0).toUpperCase();
 return `<div class="tool-icon"><span class="placeholder">${escapeHtml(letter)}</span></div>`;
}

// --- repo catalog (HALO STIX) ---
// repoTools: array of {id, name, category, url} fetched from /api/repo.
// Merged with installed tools so the user sees every category, plus a "Get"
// link for tools not installed yet.
let repoTools = [];
let repoById = {};

async function loadRepo(){
 try {
  const r = await fetch('/api/repo');
  if(!r.ok) throw new Error('repo HTTP '+r.status);
  const j = await r.json();
  repoTools = Array.isArray(j && j.tools) ? j.tools : [];
  repoById = {};
  for(const t of repoTools){
   if(t && t.id) repoById[String(t.id).toLowerCase()] = t;
  }
 } catch(e){
  repoTools = [];
  repoById = {};
 }
}

function buildMergedTools(installedTools){
 // Start with installed tools; each will overwrite its repo twin if present.
 const byId = {};
 for(const t of (installedTools||[])) byId[String(t._id).toLowerCase()] = Object.assign({installed:true}, t);
 // Walk the repo; for ids not already installed, synthesize a placeholder row.
 for(const entry of repoTools){
  const id = String(entry.id||'').toLowerCase();
  if(!id || byId[id]) continue;
  byId[id] = {
   _id: entry.id,
   name: entry.name || entry.id,
   description: 'Not installed. Available in the tools storage.',
   icon: '',
   url: entry.url,
   status: {state:'notinstalled'},
   added: false,
   installed: false,
   repo: entry,
  };
 }
 return Object.values(byId);
}

const CHEVRON_SVG='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

function renderCategorizedTools(tools){
 if(!toolsCategories) { toolsList.innerHTML = (tools||[]).map(renderToolRow).join(''); return; }
 const arr = buildMergedTools(tools);
 const byCat = Object.fromEntries(CATEGORIES.map(c=>[c.id,[]]));
 for(const t of arr){
  // Category preference: repo's category field > fallback id lookup > 'other'.
  const repoEntry = repoById[String(t._id).toLowerCase()];
  let cid = (repoEntry && repoEntry.category) || categoryForToolId(t._id);
  if(!byCat[cid]) cid = 'other';
  byCat[cid].push(t);
 }
 // Always show every category, even if empty, so the taxonomy is discoverable.
 toolsCategories.innerHTML = CATEGORIES.map(c=>{
  const items = byCat[c.id];
  const open = items.length > 0; // auto-open categories that have content
  const body = items.length
   ? '<div class="tools-category-body">' + items.map(renderToolRow).join('') + '</div>'
   : '<div class="tools-category-empty">No tools in this category yet.</div>';
  return '<details class="tools-category' + (open ? ' open' : '') + '" data-cat="' + escapeHtml(c.id) + (open ? '" open' : '"') + '>'
   + '<summary><span class="cat-icon" aria-hidden="true">' + c.icon + '</span>'
   + '<span class="cat-name">' + escapeHtml(c.name) + '</span>'
   + '<span class="cat-count">' + items.length + '</span>'
   + '<span class="cat-chevron" aria-hidden="true">' + CHEVRON_SVG + '</span></summary>'
   + body + '</details>';
 }).join('');
}

function renderToolRow(t){
 // Not-installed repo placeholder: render a compact "Get from storage" row.
 if(t && t.installed === false){
  const repo = t.repo || {};
  const storageUrl = repo.url || t.url || '';
  const action = storageUrl
   ? '<a class="btn-primary btn-small" target="_blank" rel="noopener noreferrer" href="'+escapeHtml(storageUrl)+'" data-act="storage-link">Get from storage</a>'
   : '<span class="muted">no storage URL</span>';
  return '<li class="tool-row not-installed" data-id="'+escapeHtml(t._id)+'">'
   + '<div class="tool-icon"><span class="placeholder">'+escapeHtml((t.name||t._id||'?').charAt(0).toUpperCase())+'</span></div>'
   + '<div class="tool-info">'
   + '<div class="tool-name">'+escapeHtml(t.name||t._id)+' <span class="tool-status not-installed-tag" title="Not installed">not installed</span></div>'
   + '<div class="tool-desc" title="'+escapeHtml(t.description||'')+'">'+escapeHtml(t.description||'\u2014')+'</div>'
   + (repo.category ? '<div class="tool-meta muted">Storage: <code>'+escapeHtml(repo.category)+'</code></div>' : '')
   + '</div>'
   + '<div class="tool-actions">'+action+'</div>'
   + '</li>';
 }
 const added=t.added!==false; // default to "not added" if server omits the flag
 const bg=added?'':'<span class="tool-status hidden-tag" title="Not on dashboard">not added</span>';
 return `<li class="tool-row ${added?'':'not-added'}" data-id="${escapeHtml(t._id)}">
  ${iconFor(t)}
  <div class="tool-info">
   <div class="tool-name">${escapeHtml(t.name||t._id)} ${statusBadgeFor(t)} ${bg}</div>
   <div class="tool-desc" title="${escapeHtml(t.description||'')}">${escapeHtml(t.description||'\u2014')}</div>
  </div>
  <div class="tool-actions">
   <label class="tool-toggle" title="Add to dashboard">
    <input type="checkbox" data-act="visibility" ${added?'checked':''}>
    <span class="switch"></span>
    <span class="toggle-label">${added?'Added':'Add'}</span>
   </label>
   <button type="button" class="btn-danger btn-small" data-act="delete">Delete</button>
  </div>
 </li>`;
}

function renderDeleteConfirm(row,toolId){
 const existing=row.querySelector('.tool-delete-confirm');
 if(existing){ existing.remove(); row.classList.remove('delete-pending'); return; }
 const div=document.createElement('div');
 div.className='tool-delete-confirm';
 div.innerHTML=`<span class="muted">Delete <code>${escapeHtml(toolId)}</code>?</span>
  <label><input type="checkbox" data-confirm="delete-data"> Also delete <code>data/${escapeHtml(toolId)}/</code></label>
  <span class="confirm-spacer"></span>
  <button type="button" class="btn-secondary btn-small" data-act="delete-cancel">Cancel</button>
  <button type="button" class="btn-danger btn-small" data-act="delete-confirm">Delete</button>`;
 row.appendChild(div);
 row.classList.add('delete-pending');
}

async function loadSettingsPane(){
 try{
  const [sR,tR,rR]=await Promise.all([fetch('/api/settings'),fetch('/api/settings/tools'),loadRepo()]);
  if(!sR.ok) throw new Error('settings HTTP '+sR.status);
  if(!tR.ok) throw new Error('tools HTTP '+tR.status);
  if(rR && rR.ok===false) {/* repo load failed but settings still usable */}
  serverSettings=await sR.json();
  const tools=await tR.json();
  if(!serverSettings.ui) serverSettings.ui={...DEFAULT_UI};
  populateGeneralFromSettings();
  renderCategorizedTools(tools);
  if(!Array.isArray(tools) || tools.length===0){
   toolsEmpty.hidden=false;
  }else{
   toolsEmpty.hidden=true;
  }
 }catch(e){
  setStatus('Failed to load settings: '+e.message,'error');
 }
}

async function openSettings(){
 // Optimistic theme from localStorage so it doesn't flash while we fetch
 const cached=(function(){ try{ return localStorage.getItem(LS_THEME_KEY); }catch(e){ return null; }})();
 if(cached) document.documentElement.dataset.theme=cached;
 const last=(function(){ try{ return sessionStorage.getItem('ai-workbench-settings-tab'); }catch(e){ return null; }})();
 selectTab(last==='tools'?'tools':'general');
 settingsOverlay.classList.add('open');
 settingsOverlay.setAttribute('aria-hidden','false');
 setStatus('');
 await loadSettingsPane();
 // Apply the server-side theme now that we have it
 applyTheme((serverSettings.ui&&serverSettings.ui.theme)||'dark');
}

function closeSettings(){
 settingsOverlay.classList.remove('open');
 settingsOverlay.setAttribute('aria-hidden','true');
 setStatus('');
}

settingsToggle.addEventListener('click',openSettings);
settingsClose.addEventListener('click',closeSettings);
settingsOverlay.addEventListener('click',e=>{ if(e.target===settingsOverlay) closeSettings(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape' && settingsOverlay.classList.contains('open')) closeSettings(); });

// Save (General tab) -> PUT /api/settings
settingsSave.addEventListener('click',async()=>{
 const next={...serverSettings};
 next.ui={
  ...(next.ui||{}),
  theme:settingTheme.value||'dark',
  host:settingHost.value.trim(),
  port:settingPort.value.trim(),
  refresh:parseInt(settingRefresh.value,10)||5,
 };
 try{
  const r=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});
  const j=await r.json();
  if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
  serverSettings=j;
  applyTheme((serverSettings.ui&&serverSettings.ui.theme)||'dark');
  setStatus('Saved.','ok');
  // Refresh the dashboard so any visibility changes elsewhere are reflected
  if(typeof load==='function') load();
 }catch(e){
  setStatus('Save failed: '+e.message,'error');
 }
});

// Reset to defaults: General UI defaults + clear added_tools (nothing pinned). Does NOT touch files on disk.
settingsReset.addEventListener('click',async()=>{
 const next={added_tools:[],ui:{...DEFAULT_UI}};
 try{
  const r=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});
  const j=await r.json();
  if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
  serverSettings=j;
  populateGeneralFromSettings();
  applyTheme(serverSettings.ui.theme);
  await loadSettingsPane();
  setStatus('Settings reset to defaults.','ok');
 }catch(e){
  setStatus('Reset failed: '+e.message,'error');
 }
});

// --- Tools pane actions ---
toolsRefresh.addEventListener('click',()=>loadSettingsPane());

// --- Add Tool: file picker -> validate -> review -> install ---
let currentAddTask=null;
let currentToolId=null;
let existingTools=new Set();

function setAddStatus(msg,kind){
 if(!toolAddStatus) return;
 toolAddStatus.textContent=msg||'';
 toolAddStatus.classList.remove('ok','error');
 if(kind) toolAddStatus.classList.add(kind);
 toolAddStatus.hidden=!msg;
}

function refreshExistingTools(){
 existingTools=new Set();
 try{
  const nodes=toolsList.querySelectorAll('.tool-row');
  nodes.forEach(n=>{
   const id=n.dataset&&n.dataset.id;
   if(id) existingTools.add(id);
  });
 }catch(e){}
}

function resetReview(){
 toolReviewSection.hidden=true;
 toolReviewWarnings.hidden=true;
 toolReviewOverwrite.hidden=true;
 toolReviewInstall.hidden=false;
 toolReviewOverwriteBtn.hidden=true;
 toolReviewWarningsList.innerHTML='';
 toolReviewFilesList.innerHTML='';
 if(toolReviewId) toolReviewId.textContent='\u2014';
 if(toolReviewName) toolReviewName.textContent='\u2014';
 if(toolReviewKind) toolReviewKind.textContent='\u2014';
 if(toolReviewUrl) toolReviewUrl.textContent='\u2014';
 if(toolReviewDescription) toolReviewDescription.textContent='\u2014';
 if(toolReviewIcon) toolReviewIcon.textContent='\u2014';
 if(toolReviewNotes) toolReviewNotes.textContent='\u2014';
 currentAddTask=null;
}

function renderReview(meta){
 const fields=[
  [toolReviewId, meta.id, true],
  [toolReviewName, meta.name],
  [toolReviewKind, meta.kind],
  [toolReviewUrl, meta.url, true],
  [toolReviewDescription, meta.description],
  [toolReviewIcon, meta.icon, true],
  [toolReviewNotes, meta.notes],
 ];
 fields.forEach(([el,val,isCode])=>{
  if(!el) return;
  if(val==null || val===''){
   el.innerHTML='<span class="muted">(none)</span>';
  }else if(isCode){
   el.innerHTML='<code>'+escapeHtml(val)+'</code>';
  }else{
   el.textContent=String(val);
  }
 });
 // Files detected
 toolReviewFilesList.innerHTML='';
 (meta.files||[]).forEach(f=>{
  const li=document.createElement('li');
  li.textContent=f;
  toolReviewFilesList.appendChild(li);
 });
 // Warnings
 toolReviewWarningsList.innerHTML='';
 if(meta.warnings && meta.warnings.length){
  meta.warnings.forEach(w=>{
   const li=document.createElement('li');
   li.textContent=w;
   toolReviewWarningsList.appendChild(li);
  });
  toolReviewWarnings.hidden=false;
 }else{
  toolReviewWarnings.hidden=true;
 }
 // Overwrite check
 refreshExistingTools();
 const exists=existingTools.has(meta.id);
 if(exists){
  toolReviewOverwriteId.textContent=meta.id;
  toolReviewOverwrite.hidden=false;
  toolReviewInstall.hidden=true;
  toolReviewOverwriteBtn.hidden=false;
 }else{
  toolReviewOverwrite.hidden=true;
  toolReviewInstall.hidden=false;
  toolReviewOverwriteBtn.hidden=true;
 }
}

toolAddBtn.addEventListener('click',()=>{
 toolAddFile.value='';
 toolAddFile.click();
});

toolAddFile.addEventListener('change',async()=>{
 const f=toolAddFile.files && toolAddFile.files[0];
 if(!f) return;
 setAddStatus('Validating '+f.name+'...','');
 toolAddBtn.disabled=true;
 resetReview();
 currentToolId=null;
 try{
  const fd=new FormData();
  fd.append('file',f);
  const r=await fetch('/api/tools/preview',{method:'POST',body:fd});
  const j=await r.json();
  if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
  if(!j.valid){
   setAddStatus('Validation failed: '+(j.error||'Archive is missing required files.'),'error');
   return;
  }
  currentToolId=j.id;
  // Render review
  renderReview(j);
  toolReviewSection.hidden=false;
  setAddStatus('Validated. Review the tool and click Install to add it.','ok');
 }catch(e){
  setAddStatus('Validation failed: '+e.message,'error');
 }finally{
  toolAddBtn.disabled=false;
 }
});

toolReviewCancel.addEventListener('click',()=>{
 resetReview();
 setAddStatus('Cancelled.','');
});

async function startInstall(mode){
 const id=currentToolId;
 if(!id){ setAddStatus('No tool selected.','error'); return; }
 const btn=mode==='overwrite'?toolReviewOverwriteBtn:toolReviewInstall;
 btn.disabled=true;
 toolReviewCancel.disabled=true;
 try{
  const fd=new FormData();
  // Server keeps the staged zip from /preview, but we don't expose that token.
  // Instead, just send the original file again with mode=overwrite|new.
  // (Server uses the same upload endpoint for installation.)
  // We rebuild FormData with the last selected file (stored on the input).
  const f=toolAddFile.files && toolAddFile.files[0];
  if(!f) throw new Error('Source file missing; please reselect the zip.');
  fd.append('id',id);
  fd.append('mode',mode);
  fd.append('file',f);
  const r=await fetch('/api/tools/upload',{method:'POST',body:fd});
  const j=await r.json();
  if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
  if(j.output && j.output.includes('Task ID:')){
   const taskId=j.output.split('Task ID:')[1].trim();
   await runBgTask(id,taskId,'upload',async()=>{
    await loadSettingsPane();
    resetReview();
    setAddStatus(mode==='overwrite'?`Reinstalled ${id}.`:'Installed '+id+'.','ok');
    if(typeof load==='function') load();
   });
  }else{
   setAddStatus('Install started.','ok');
  }
 }catch(e){
  setAddStatus('Install failed: '+e.message,'error');
  btn.disabled=false;
  toolReviewCancel.disabled=false;
 }
}

toolReviewInstall.addEventListener('click',()=>startInstall('new'));
toolReviewOverwriteBtn.addEventListener('click',()=>startInstall('replace'));

// Tool row delegated actions (visibility toggle, delete)
toolsList.addEventListener('click',async e=>{
 const row=e.target.closest('.tool-row');
 if(!row) return;
 const id=row.dataset.id;
 const actEl=e.target.closest('[data-act]');
 if(!actEl) return;
 const act=actEl.dataset.act;
 if(act==='visibility'){
  const cb=actEl;
  const added=cb.checked;
  // Optimistic UI update
  row.classList.toggle('not-added',!added);
  const lbl=row.querySelector('.tool-toggle .toggle-label');
  if(lbl) lbl.textContent=added?'Added':'Add';
  try{
   const r=await fetch(`/api/tools/${encodeURIComponent(id)}/visibility`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({added})});
   const j=await r.json();
   if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
   serverSettings.added_tools=j.added_tools||serverSettings.added_tools;
   if(typeof load==='function') load();
   setStatus(added?`Added ${id} to dashboard.`:`Removed ${id} from dashboard.`,'ok');
  }catch(err){
   // Revert on failure
   cb.checked=!added;
   row.classList.toggle('not-added',added);
   if(lbl) lbl.textContent=added?'Add':'Added';
   setStatus('Visibility change failed: '+err.message,'error');
  }
  return;
 }
 if(act==='delete'){
  renderDeleteConfirm(row,id);
  return;
 }
 if(act==='delete-cancel'){
  const conf=row.querySelector('.tool-delete-confirm');
  if(conf) conf.remove();
  row.classList.remove('delete-pending');
  return;
 }
 if(act==='delete-confirm'){
  const conf=row.querySelector('.tool-delete-confirm');
  const delData=conf && conf.querySelector('input[data-confirm="delete-data"]').checked;
  const btn=row.querySelector('[data-act="delete-confirm"]');
  btn.disabled=true;
  try{
   const r=await fetch(`/api/tools/${encodeURIComponent(id)}?delete_data=${delData?1:0}`,{method:'DELETE'});
   const j=await r.json();
   if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
   if(j.output && j.output.includes('Task ID:')){
    const taskId=j.output.split('Task ID:')[1].trim();
    await runBgTask(id,taskId,'delete',async()=>{ await loadSettingsPane(); setStatus(`Deleted ${id}.`,'ok'); if(typeof load==='function') load(); });
   }else{
    await loadSettingsPane();
    setStatus('Delete started.','ok');
   }
  }catch(err){
   setStatus('Delete failed: '+err.message,'error');
   btn.disabled=false;
  }
  return;
 }
});

// Reuse the existing sidebar log mechanism (autoExpand + logDot)
async function runBgTask(toolId,taskId,action,onDone){
 if(typeof activeTasks!=='undefined'){ activeTasks++; autoCollapse=true; expandSidebar(); logDot.classList.add('busy'); }
 logEl.textContent=`${action} ${toolId}...`;
 try{
  await pollTaskStatus(toolId,taskId,action);
  if(typeof onDone==='function') await onDone();
 }catch(e){
  setStatus(`${action} failed: ${e.message}`,'error');
 }finally{
  if(typeof activeTasks!=='undefined'){
   activeTasks--;
   if(activeTasks<=0){ activeTasks=0; logDot.classList.remove('busy'); }
  }
 }
}

// Initial theme: prefer local cache so the page paints correctly before any fetch.
(function initTheme(){
 const cached=(function(){ try{ return localStorage.getItem(LS_THEME_KEY); }catch(e){ return null; }})();
 if(cached){ document.documentElement.dataset.theme=cached; }
})();

async function act(id, action){
 activeTasks++;
 autoCollapse=true;
 expandSidebar();
 logDot.classList.add('busy');
 logEl.textContent=`${action} ${id}...`;
 try{
  const r=await fetch(`/api/tools/${id}/${action}`,{method:'POST'});
  const x=await r.json();
  if(x.ok && x.output && x.output.includes("Task ID:")){
   // Background task started - extract task ID and poll for status
   const taskId = x.output.split("Task ID:")[1].trim();
   logEl.textContent=`${action} started. Building... (this may take 20-60 minutes for first build)`;
   await pollTaskStatus(id, taskId, action);
  }else{
   logEl.textContent=x.output||x.error||'Done';
  }
 }catch(e){
  logEl.textContent=`Error: ${e.message}`;
 }finally{
  activeTasks--;
  if(activeTasks<=0){ activeTasks=0; logDot.classList.remove('busy'); }
  await load();
  if(activeTasks===0 && autoCollapse){
   setTimeout(()=>{ if(autoCollapse && activeTasks===0) collapseSidebar(); },800);
  }
 }
}

async function pollTaskStatus(toolId, taskId, action){
 return new Promise((resolve, reject) => {
  const pollInterval = 5000; // Poll every 5 seconds
  const maxDuration = 3600000; // 1 hour max
  const startTime = Date.now();
  
  const poll = async () => {
   try {
    const r = await fetch(`/api/tools/${toolId}/task/${taskId}`);
    const task = await r.json();
    
    if(task.error){
     logEl.textContent=`Error: ${task.error}`;
     reject(new Error(task.error));
     return;
    }
    
    const duration = Math.round(task.duration);
    logEl.textContent=`${action} ${toolId}: ${task.status} (${duration}s)`;
    
    if(task.status === 'completed'){
     logEl.textContent=`${action} completed successfully!`;
     resolve();
     return;
    }else if(task.status === 'failed'){
     logEl.textContent=`${action} failed: ${task.output || 'Unknown error'}`;
     reject(new Error(task.output || 'Operation failed'));
     return;
    }
    
    // Check if we've exceeded max duration
    if(Date.now() - startTime > maxDuration){
     logEl.textContent=`${action} timed out after 1 hour`;
     reject(new Error('Operation timed out'));
     return;
    }
    
    // Continue polling
    setTimeout(poll, pollInterval);
   }catch(e){
    logEl.textContent=`Error checking status: ${e.message}`;
    reject(e);
   }
  };
  
  // Start polling
  setTimeout(poll, pollInterval);
 });
}
load(); setInterval(load,5000);

// --- System stats graphs ---
const HISTORY=60;
const history={cpu:[],ram:[],gpu:[],vram:[]};
const colors={cpu:'#2b6cff',ram:'#38c97a',gpu:'#ff8c42',vram:'#b06cff'};

function drawGraph(id,data,max){
 const c=document.getElementById(id);
 if(!c)return;
 const ctx=c.getContext('2d');
 const w=c.width,h=c.height;
 ctx.clearRect(0,0,w,h);
 if(data.length<2)return;
 const step=w/(HISTORY-1);
 ctx.beginPath();
 ctx.moveTo(0,h-data[0]/max*h);
 for(let i=1;i<data.length;i++){
   ctx.lineTo(i*step,h-data[i]/max*h);
 }
 ctx.strokeStyle=colors[id.replace('g-','')];
 ctx.lineWidth=1.5;
 ctx.stroke();
 ctx.lineTo((data.length-1)*step,h);
 ctx.lineTo(0,h);
 ctx.closePath();
 ctx.fillStyle=colors[id.replace('g-','')]+'20';
 ctx.fill();
}

function updateStats(d){
 history.cpu.push(d.cpu); if(history.cpu.length>HISTORY)history.cpu.shift();
 history.ram.push(d.ram); if(history.ram.length>HISTORY)history.ram.shift();
 history.gpu.push(d.gpu); if(history.gpu.length>HISTORY)history.gpu.shift();
 history.vram.push(d.vram); if(history.vram.length>HISTORY)history.vram.shift();

 drawGraph('g-cpu',history.cpu,100);
 drawGraph('g-ram',history.ram,100);
 drawGraph('g-gpu',history.gpu,100);
 drawGraph('g-vram',history.vram,100);

 document.getElementById('v-cpu').textContent=d.cpu+'%';
 document.getElementById('v-ram').textContent=d.ram+'%';
 document.getElementById('v-gpu').textContent=d.gpu+'%';
 document.getElementById('v-vram').textContent=d.vram_used+' / '+d.vram_total+' GB';
 document.getElementById('v-temp').textContent=d.temp+'°C';
}

const es=new EventSource('/api/stats');
es.onmessage=e=>{
 try{updateStats(JSON.parse(e.data))}catch(x){}
};
es.onerror=()=>{setTimeout(()=>{es.close()},1000)};
