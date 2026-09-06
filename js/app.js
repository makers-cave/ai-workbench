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
const toolInstallId=document.getElementById('tool-install-id');
const toolInstallUrl=document.getElementById('tool-install-url');
const toolInstallBtn=document.getElementById('tool-install-btn');
const toolUploadId=document.getElementById('tool-upload-id');
const toolUploadMode=document.getElementById('tool-upload-mode');
const toolUploadBtn=document.getElementById('tool-upload-btn');
const toolUploadFile=document.getElementById('tool-upload-file');
const toolsList=document.getElementById('tools-list');
const toolsEmpty=document.getElementById('tools-empty');
const toolsRefresh=document.getElementById('tools-refresh');

// localStorage is now only used as a quick theme cache; server is authoritative.
const LS_THEME_KEY='ai-workbench-theme';
const DEFAULT_UI={theme:'dark',host:'',port:'',refresh:5};
const ID_RE=/^[a-z0-9][a-z0-9_-]{0,39}$/;
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

function renderToolRow(t){
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
  const [sR,tR]=await Promise.all([fetch('/api/settings'),fetch('/api/settings/tools')]);
  if(!sR.ok) throw new Error('settings HTTP '+sR.status);
  if(!tR.ok) throw new Error('tools HTTP '+tR.status);
  serverSettings=await sR.json();
  const tools=await tR.json();
  if(!serverSettings.ui) serverSettings.ui={...DEFAULT_UI};
  populateGeneralFromSettings();
  if(!Array.isArray(tools) || tools.length===0){
   toolsList.innerHTML='';
   toolsEmpty.hidden=false;
  }else{
   toolsList.innerHTML=tools.map(renderToolRow).join('');
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

toolInstallBtn.addEventListener('click',async()=>{
 const id=(toolInstallId.value||'').trim();
 const url=(toolInstallUrl.value||'').trim();
 if(!ID_RE.test(id)){ setStatus('Tool id must match [a-z0-9][a-z0-9_-]{0,39}','error'); toolInstallId.focus(); return; }
 if(!/^https?:\/\//i.test(url)){ setStatus('URL must start with http(s)://','error'); toolInstallUrl.focus(); return; }
 toolInstallBtn.disabled=true;
 try{
  const r=await fetch('/api/tools/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,url})});
  const j=await r.json();
  if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
  if(j.output && j.output.includes('Task ID:')){
   const taskId=j.output.split('Task ID:')[1].trim();
   await runBgTask(id,taskId,'install',async()=>{ await loadSettingsPane(); toolInstallId.value=''; toolInstallUrl.value=''; setStatus(`Installed ${id}.`,'ok'); if(typeof load==='function') load(); });
  }else{
   setStatus('Install started.','ok');
  }
 }catch(e){
  setStatus('Install failed: '+e.message,'error');
 }finally{
  toolInstallBtn.disabled=false;
 }
});

toolUploadBtn.addEventListener('click',()=>{
 const id=(toolUploadId.value||'').trim();
 if(!ID_RE.test(id)){ setStatus('Enter a valid tool id first.','error'); toolUploadId.focus(); return; }
 toolUploadFile.dataset.toolId=id;
 toolUploadFile.dataset.mode=toolUploadMode.value||'new';
 toolUploadFile.value=''; // allow re-selecting same file
 toolUploadFile.click();
});
toolUploadFile.addEventListener('change',async()=>{
 const f=toolUploadFile.files&&toolUploadFile.files[0];
 const id=toolUploadFile.dataset.toolId;
 const mode=toolUploadFile.dataset.mode||'new';
 if(!f||!id) return;
 const fd=new FormData();
 fd.append('id',id);
 fd.append('mode',mode);
 fd.append('file',f);
 toolUploadBtn.disabled=true;
 try{
  const r=await fetch('/api/tools/upload',{method:'POST',body:fd});
  const j=await r.json();
  if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
  if(j.output && j.output.includes('Task ID:')){
   const taskId=j.output.split('Task ID:')[1].trim();
   await runBgTask(id,taskId,'upload',async()=>{ await loadSettingsPane(); toolUploadId.value=''; setStatus(`Uploaded zip into ${id}.`,'ok'); if(typeof load==='function') load(); });
  }else{
   setStatus('Upload started.','ok');
  }
 }catch(e){
  setStatus('Upload failed: '+e.message,'error');
 }finally{
  toolUploadBtn.disabled=false;
 }
});

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
