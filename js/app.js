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
const logDot=document.getElementById('log-dot');
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
