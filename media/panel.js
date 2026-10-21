  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const screen = $('screen'), sel = $('project'), statusEl = $('status'), msg = $('msg');
  let projects = [];
  let lastAction = null;      // ultimo boton de accion pulsado (para marcarlo "hecho")
  let doneTimer = null;
  let opHadError = false;     // hubo algun error durante la operacion en curso?
  let deselected = new Set(); // repos DES-seleccionados (por defecto todos van incluidos)
  let currentRepoNames = [];  // repos del proyecto mostrado ahora mismo
  function selectedRepoNames(){ return currentRepoNames.filter(n=>!deselected.has(n)); }
  function ensureSelection(){ if(currentRepoNames.length>1 && selectedRepoNames().length===0){ clearScreen(); line('Selecciona al menos un repo','err'); return false; } return true; }

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function line(text, level){ const d=document.createElement('div'); d.className=level||'info'; d.textContent=text;
    screen.appendChild(d); screen.scrollTop=screen.scrollHeight; }
  function clearScreen(){ screen.innerHTML=''; }
  function setHint(html){ screen.innerHTML='<div class="greet">'+html+'</div>'; }
  function autogrow(){ msg.style.height='auto'; msg.style.height=Math.min(msg.scrollHeight,170)+'px'; }

  // --- personalidad de la mascota ---
  const PHRASES = {
    hi: [
      'Buenas &#9749; &iquest;en qu&eacute; <b>repo</b> andamos hoy?',
      '&iexcl;Hola! Ponme un <b>proyecto</b> y te cuento c&oacute;mo va &#9749;',
      'Listo para el caf&eacute;&hellip; digo, para el <b>git</b> &#9749;',
      '&iquest;Un cafecito mientras revisamos tus <b>ramas</b>? &#9749;'
    ],
    happy: [
      '&iexcl;Reci&eacute;n hecho! &#9749;',
      '&iexcl;Servido! &#10024;',
      'Suave como un buen latte &#9749;',
      '&iexcl;Ese commit huele a gloria! &#10024;',
      '&iexcl;Listo, sin derramar una gota! &#9749;'
    ],
    oops: [
      'Uy&hellip; se me derram&oacute; el caf&eacute; &#9749;',
      'Ups, algo no cuaj&oacute;. Probemos otra vez.',
      'Mmm, se me atragant&oacute; el sorbo &#9749;'
    ]
  };
  function pick(a){ return a[(Math.random()*a.length)|0]; }
  // dispara una reaccion breve (happy / oops) reiniciando la animacion
  function mascot(state){ const b=$('bot'); if(!b) return; b.classList.remove('happy','oops'); void b.offsetWidth; b.classList.add(state); setTimeout(()=>b.classList.remove(state), 900); }
  let busy=false;
  function setBusy(b){ busy=b; ['check','pull','commit','push','suggest'].forEach(id=>{ const el=$(id); if(el) el.disabled=b; }); sel.disabled=b;
    const bot=$('bot'); if(bot){ bot.classList.toggle('working',b); if(b) bot.classList.remove('happy','oops'); }
    const cb=$('cancel'); if(cb) cb.classList.toggle('show',b);
    if(b){ clearDone(); opHadError=false; } }
  // limpia el visto verde de todos los botones de accion
  function clearDone(){ if(doneTimer){ clearTimeout(doneTimer); doneTimer=null; }
    ['check','pull','commit','push'].forEach(id=>{ const el=$(id); if(el) el.classList.remove('done'); }); }
  // marca el ultimo boton pulsado como "hecho" (verde + visto) unos segundos
  function markDone(){ if(!lastAction || opHadError){ lastAction=null; return; } const el=lastAction; lastAction=null;
    clearDone(); el.classList.add('done'); doneTimer=setTimeout(()=>{ el.classList.remove('done'); doneTimer=null; }, 1800); }
  function requestStatus(){ if(sel.value){ statusEl.innerHTML='<div class="srow"><span class="repo">cargando estado...</span></div>'; vscode.postMessage({cmd:'status', project:sel.value}); } }

  function fileClass(code){
    const c=(code||'').trim();
    if(c.indexOf('?')>=0) return 'c-new';
    if(c.indexOf('D')>=0) return 'c-del';
    if(c.indexOf('A')>=0) return 'c-add';
    return 'c-mod';
  }

  let mainBranch = '';        // rama principal del proyecto actual (para "Ir a main")

  function renderBranchBar(branches, current){
    const bar=$('branchbar'), bsel=$('branchsel'), blab=bar.querySelector('.blabel'), gm=$('gotomain');
    if(!branches || !branches.length){ bar.style.display='none'; return; }
    bar.style.display='flex';
    if(blab) blab.textContent='Rama ('+branches.length+')';
    bsel.innerHTML='';
    if(!current){ const o=document.createElement('option'); o.value=''; o.textContent='(varias ramas)'; bsel.appendChild(o); }
    branches.forEach(b=>{ const o=document.createElement('option'); o.value=b; o.textContent=b; if(b===current)o.selected=true; bsel.appendChild(o); });
    // el boton "Ir a main" solo cuando estas seguro fuera de la rama principal
    const show = mainBranch && current && current!==mainBranch;
    if(gm){ gm.style.display = show ? 'flex' : 'none'; gm.title='Volver a '+mainBranch; gm.innerHTML='&#8962; '+mainBranch; }
  }

  function renderStatus(p, repos, branches, current, hint, mainB){
    if(sel.value!==p) return;
    mainBranch = mainB || '';
    renderBranchBar(branches, current);
    if(hint) setHint(hint);
    statusEl.innerHTML='';
    currentRepoNames = repos.map(r=>r.name);
    for(const n of Array.from(deselected)) if(!currentRepoNames.includes(n)) deselected.delete(n);
    repos.forEach(r=>{
      const hasFiles = r.files && r.files.length;
      let state='st-clean';
      if(r.hasRemote===false) state='st-warn';
      else if(r.dirty>0) state='st-dirty';
      else if(r.behind>0) state='st-warn';
      else if(r.ahead>0 && !r.phantomAhead) state='st-ahead';
      const row=document.createElement('div'); row.className='srow '+state+(hasFiles?' has':'');
      const multi = repos.length>1 ? '<span class="repo">'+esc(r.name)+'</span>' : '';
      const caret = hasFiles ? '<span class="caret">&#9656;</span>' : '';
      let badges='';
      if(r.dirty>0) badges+='<span class="badge state b-dirty">'+r.dirty+' cambio'+(r.dirty>1?'s':'')+'</span>';
      else badges+='<span class="badge state b-clean">&#10003; limpio</span>';
      if(r.phantomAhead) badges+=' <span class="badge b-phantom" title="Estos commits ya viven en main en el servidor; no necesitas Push">&#8593;'+r.ahead+' ya en main</span>';
      else if(r.ahead>0) badges+=' <span class="badge b-up">&#8593;'+r.ahead+'</span>';
      if(r.behind>0) badges+=' <span class="badge b-dn">&#8595;'+r.behind+'</span>';
      if(r.mergedInMain && !r.onMain && r.dirty===0 && !r.phantomAhead && r.ahead===0) badges+=' <span class="badge b-merged" title="Su trabajo ya vive en main">fusionada</span>';
      if(r.hasRemote===false) badges+=' <span class="badge b-noremote">sin remoto</span>';
      row.innerHTML='<span class="br"><span class="dot"></span><span class="ico">&#9095;</span>'+esc(r.branch)+' '+multi+caret+'</span><span class="badges">'+badges+'</span>';
      // en proyectos multi-repo, checkbox para elegir a que repos aplicar Commit/Push/Pull/Check
      if(repos.length>1){
        const cb=document.createElement('input'); cb.type='checkbox'; cb.className='rsel';
        cb.checked=!deselected.has(r.name); cb.title='Incluir '+r.name+' en Commit / Push / Pull / Check';
        cb.style.marginRight='7px'; cb.style.cursor='pointer'; cb.style.accentColor='#e0912f'; cb.style.flex='0 0 auto';
        cb.addEventListener('click', ev=>{ ev.stopPropagation(); if(cb.checked) deselected.delete(r.name); else deselected.add(r.name); });
        row.insertBefore(cb, row.firstChild);
      }
      statusEl.appendChild(row);
      if(hasFiles){
        const fl=document.createElement('div'); fl.className='files';
        r.files.forEach(f=>{
          const div=document.createElement('div'); div.className='f'; div.style.cursor='pointer'; div.title='Ver diff';
          const c=document.createElement('span'); c.className='c '+fileClass(f.code); c.textContent=(f.code||'').trim()||'M';
          const pth=document.createElement('span'); pth.className='p'; pth.textContent=f.path;
          div.appendChild(c); div.appendChild(pth); fl.appendChild(div);
          div.addEventListener('click', ev=>{ ev.stopPropagation(); vscode.postMessage({cmd:'opendiff', project:sel.value, repo:r.name, path:f.path, code:f.code}); });
        });
        statusEl.appendChild(fl);
        row.addEventListener('click', ()=>{ row.classList.toggle('open'); fl.classList.toggle('open'); });
      }
    });
  }

  sel.addEventListener('change', ()=>{ if(!sel.value) return; deselected.clear(); requestStatus(); vscode.postMessage({cmd:'select', project:sel.value}); });
  $('branchsel').addEventListener('change', ()=>{ const b=$('branchsel').value; if(!sel.value||!b)return; clearScreen(); vscode.postMessage({cmd:'switch', project:sel.value, branch:b}); });
  $('gotomain').addEventListener('click', ()=>{ if(!sel.value||!mainBranch)return; clearScreen(); vscode.postMessage({cmd:'switch', project:sel.value, branch:mainBranch}); });
  $('newbranch').addEventListener('click', ()=>{ if(!sel.value)return; vscode.postMessage({cmd:'newbranch', project:sel.value}); });
  $('check').addEventListener('click', ()=>{ if(!sel.value||!ensureSelection())return; clearScreen(); lastAction=$('check'); vscode.postMessage({cmd:'check', project:sel.value, repos:selectedRepoNames()}); });
  $('pull').addEventListener('click', ()=>{ if(!sel.value||!ensureSelection())return; clearScreen(); lastAction=$('pull'); vscode.postMessage({cmd:'pull', project:sel.value, repos:selectedRepoNames()}); });
  msg.addEventListener('input', autogrow);
  $('commit').addEventListener('click', ()=>{ if(!sel.value)return; if(!ensureSelection())return; if(!msg.value.trim()){ clearScreen(); line('Escribe un mensaje de commit','err'); msg.focus(); return; } clearScreen(); lastAction=$('commit'); vscode.postMessage({cmd:'commit', project:sel.value, message:msg.value.trim(), repos:selectedRepoNames()}); msg.value=''; autogrow(); });
  $('push').addEventListener('click', ()=>{ if(!sel.value||!ensureSelection())return; clearScreen(); lastAction=$('push'); vscode.postMessage({cmd:'push', project:sel.value, repos:selectedRepoNames()}); });
  $('suggest').addEventListener('click', ()=>{ if(!sel.value||!ensureSelection())return; clearScreen(); line('Analizando cambios…','dim'); vscode.postMessage({cmd:'suggest', project:sel.value, repos:selectedRepoNames(), current:msg.value}); });
  $('cancel').addEventListener('click', ()=>{ line('Cancelando…','warn'); vscode.postMessage({cmd:'cancel'}); });
  function spin(el){ if(!el)return; el.classList.remove('spin'); void el.offsetWidth; el.classList.add('spin'); }
  $('rescan').addEventListener('click', ()=>{ spin($('rescan')); vscode.postMessage({cmd:'rescan'}); });
  $('refresh').addEventListener('click', ()=>{ spin($('refresh')); requestStatus(); });
  $('popout').addEventListener('click', ()=>vscode.postMessage({cmd:'popout'}));

  // --- fondo del panel (imagen + intensidad) ---
  // rellena la pista del slider segun su valor (0..max) para el look moderno
  function bgFill(){ const r=$('bgrange'); const max=parseInt(r.max,10)||50; const pct=(parseInt(r.value,10)||0)/max*100; r.style.setProperty('--fill', pct.toFixed(1)+'%'); }
  function applyBackground(uri, opacity){
    const root=document.documentElement;
    if(uri) root.style.setProperty('--bgimg','url("'+uri+'")');
    if(typeof opacity==='number'){
      const v=Math.max(0.3, Math.min(0.97, 1-opacity)); root.style.setProperty('--veil', v.toFixed(3));
      const pct=Math.round(opacity*100); $('bgrange').value=pct; $('bgval').textContent=pct+'%'; bgFill();
    }
  }
  $('setbg').addEventListener('click', (e)=>{ e.stopPropagation(); $('bgpop').classList.toggle('show'); });
  document.addEventListener('click', (e)=>{ const p=$('bgpop'); if(p.classList.contains('show') && !p.contains(e.target) && e.target!==$('setbg') && !$('setbg').contains(e.target)) p.classList.remove('show'); });
  $('bgrange').addEventListener('input', ()=>{ const pct=parseInt($('bgrange').value,10)||0; $('bgval').textContent=pct+'%'; bgFill(); const v=Math.max(0.3,Math.min(0.97,1-pct/100)); document.documentElement.style.setProperty('--veil', v.toFixed(3)); });
  $('bgrange').addEventListener('change', ()=>{ const pct=parseInt($('bgrange').value,10)||0; vscode.postMessage({cmd:'bgOpacity', value:pct/100}); });
  $('bgpick').addEventListener('click', ()=>vscode.postMessage({cmd:'bgImage'}));
  $('bgreset').addEventListener('click', ()=>vscode.postMessage({cmd:'bgReset'}));

  window.addEventListener('message', ev=>{
    const m = ev.data;
    if(m.type==='projects'){
      const prev = sel.value;
      projects = m.projects || [];
      sel.innerHTML='';
      if(projects.length===0){ const o=document.createElement('option'); o.textContent='(sin repos detectados)'; sel.appendChild(o); }
      projects.forEach(p=>{ const o=document.createElement('option'); o.value=p.name; o.textContent=p.name+' ('+p.repos.length+')'; sel.appendChild(o); });
      if(prev && projects.some(p=>p.name===prev)) sel.value=prev;
      requestStatus();
    } else if(m.type==='select'){ if(m.project && projects.some(p=>p.name===m.project) && sel.value!==m.project){ sel.value=m.project; requestStatus(); }
    } else if(m.type==='status'){ renderStatus(m.project, m.repos, m.branches, m.current, m.hint, m.mainBranch);
    } else if(m.type==='suggest'){ msg.value=m.message; autogrow(); msg.focus(); msg.classList.add('flash'); setTimeout(()=>msg.classList.remove('flash'),700); mascot('happy');
    } else if(m.type==='busy'){ setBusy(true);
    } else if(m.type==='done'){ setBusy(false); markDone(); if(!opHadError) mascot('happy');
    } else if(m.type==='background'){ applyBackground(m.uri, m.opacity);
    } else if(m.type==='log'){ if(m.level==='err'){ opHadError=true; mascot('oops'); } line(m.text, m.level); }
  });

  // clic en la mascota = un mimo: reacciona feliz y suelta una frase (si no esta ocupada)
  $('bot').addEventListener('click', ()=>{ mascot('happy'); if(!busy) setHint(pick(PHRASES.happy)); });
  // clic en el logo de la cabecera: saltito
  const brand=document.querySelector('.brand');
  if(brand) brand.addEventListener('click', ()=>{ const l=document.querySelector('.logo'); if(l){ l.classList.remove('hi'); void l.offsetWidth; l.classList.add('hi'); setTimeout(()=>l.classList.remove('hi'),650); } });

  // saludo inicial variado (antes de que se elija un proyecto)
  setHint(pick(PHRASES.hi));
  vscode.postMessage({cmd:'ready'});
