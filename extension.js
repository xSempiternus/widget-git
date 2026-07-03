const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const targets = new Set();   // webviews vivos (vista fijada + ventana flotante)
let statusItem = null;
let cachedProjects = null;

// ---------------------------------------------------------------------------
//  Activacion
// ---------------------------------------------------------------------------
function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = '$(game) GIT ARCADE';
  statusItem.tooltip = 'Abrir el widget arcade (rama / commit / push / main)';
  statusItem.command = 'gitArcade.open';
  statusItem.show();
  context.subscriptions.push(statusItem);

  const provider = {
    resolveWebviewView(webviewView) {
      const wv = webviewView.webview;
      wv.options = { enableScripts: true };
      wv.html = getHtml();
      wv.onDidReceiveMessage(onMessage);
      targets.add(wv);
      webviewView.onDidDispose(() => targets.delete(wv));
      webviewView.onDidChangeVisibility(() => { if (webviewView.visible) sendProjects(); });
    }
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('gitArcadeView', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitArcade.open', () => vscode.commands.executeCommand('gitArcadeView.focus')),
    vscode.commands.registerCommand('gitArcade.popout', openPopout),
    vscode.commands.registerCommand('gitArcade.rescan', () => {
      cachedProjects = null; sendProjects();
      vscode.window.showInformationMessage('GIT ARCADE: proyectos re-escaneados.');
    })
  );
}

function deactivate() {}

// Abre una copia como pestaÃ±a y la manda a una ventana flotante nueva.
function openPopout() {
  const panel = vscode.window.createWebviewPanel(
    'gitArcadePop', 'Git Arcade', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const wv = panel.webview;
  wv.html = getHtml();
  wv.onDidReceiveMessage(onMessage);
  targets.add(wv);
  panel.onDidDispose(() => targets.delete(wv));
  vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
}

// ---------------------------------------------------------------------------
//  Mensajes desde el webview
// ---------------------------------------------------------------------------
async function onMessage(msg) {
  try {
    switch (msg.cmd) {
      case 'ready': sendProjects(); break;
      case 'rescan': cachedProjects = null; sendProjects(); break;
      case 'status': await sendStatus(msg.project); break;
      case 'check': await runMain('check', msg.project); break;
      case 'pull': await runMain('pull', msg.project); break;
      case 'commit': await commitAction(msg.project, msg.message); break;
      case 'push': await pushAction(msg.project); break;
      case 'switch': await switchBranch(msg.project, msg.branch); break;
      case 'newbranch': await newBranch(msg.project); break;
      case 'popout': openPopout(); break;
    }
  } catch (e) {
    post({ type: 'log', level: 'err', text: 'ERROR: ' + (e && e.message ? e.message : String(e)) });
    post({ type: 'done' });
  }
}

function post(m) { for (const wv of targets) wv.postMessage(m); }

function sendProjects() {
  const projects = getProjects();
  post({ type: 'projects', projects: projects.map(p => ({ name: p.name, repos: p.repos.map(r => r.name) })) });
}

// ---------------------------------------------------------------------------
//  Escaneo de proyectos / repos
// ---------------------------------------------------------------------------
function cfg(key, def) {
  const v = vscode.workspace.getConfiguration('gitArcade').get(key);
  return (v === undefined || v === null || v === '') ? def : v;
}

function getProjects() {
  if (cachedProjects) return cachedProjects;
  const maxDepth = cfg('scanDepth', 4);
  const rootPath = cfg('rootPath', 'C:\\Users\\nikoa\\Documents\\PROJECTS');
  const extra = cfg('extraPaths', []) || [];
  const roots = [rootPath, ...extra].filter(Boolean);
  const rootsLower = roots.map(r => String(r).toLowerCase());

  const seen = new Set();
  const repos = [];
  for (const root of roots) {
    const found = [];
    scan(root, 0, maxDepth, found);
    for (const p of found) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); repos.push(p);
    }
  }

  const groups = new Map();
  for (const repoPath of repos) {
    const parent = path.dirname(repoPath);
    const key = rootsLower.includes(parent.toLowerCase()) ? repoPath : parent;
    if (!groups.has(key)) groups.set(key, { name: path.basename(key), dir: key, repos: [] });
    groups.get(key).repos.push({ name: path.basename(repoPath), path: repoPath });
  }
  cachedProjects = Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
  return cachedProjects;
}

function scan(dir, depth, maxDepth, out) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  if (entries.some(e => e.isDirectory() && e.name === '.git')) { out.push(dir); return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const n = e.name;
    if (n === 'node_modules' || n === '.git' || n === 'dist' || n === 'build' ||
        n === '.next' || n === 'vendor' || n === '.venv' || n === '__pycache__') continue;
    scan(path.join(dir, n), depth + 1, maxDepth, out);
  }
}

// ---------------------------------------------------------------------------
//  Git helpers
// ---------------------------------------------------------------------------
function git(cwd, args) {
  return new Promise((resolve) => {
    const child = cp.spawn('git', args, { cwd, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', e => resolve({ code: -1, out: '', err: e.message }));
    child.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

async function defaultBranch(cwd) {
  const forced = cfg('mainBranch', '');
  if (forced) return forced;
  const r = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (r.code === 0 && r.out) return r.out.replace(/^origin\//, '');
  const m = await git(cwd, ['rev-parse', '--verify', '--quiet', 'origin/main']);
  return (m.code === 0) ? 'main' : 'master';
}

function findProject(name) { return getProjects().find(p => p.name === name); }

// ---------------------------------------------------------------------------
//  STATUS: rama actual + ahead/behind + cambios por repo
// ---------------------------------------------------------------------------
async function sendStatus(projectName) {
  const proj = findProject(projectName);
  if (!proj) return;
  const repos = [];
  const branchSet = new Set();
  const currents = new Set();
  for (const repo of proj.repos) {
    const branch = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || '?';
    currents.add(branch);
    const up = await git(repo.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    let ahead = 0, behind = 0; const hasUp = up.code === 0;
    if (hasUp) {
      const c = await git(repo.path, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
      const m = (c.out || '').split(/\s+/);
      behind = parseInt(m[0] || '0', 10) || 0;
      ahead = parseInt(m[1] || '0', 10) || 0;
    }
    const st = await git(repo.path, ['status', '--porcelain']);
    const lines = st.out ? st.out.split('\n').filter(Boolean) : [];
    const files = lines.slice(0, 50).map(l => ({ code: l.slice(0, 2), path: l.slice(3) }));
    // ramas locales
    const br = await git(repo.path, ['branch', '--format=%(refname:short)']);
    br.out.split('\n').map(b => b.trim()).filter(Boolean).forEach(b => branchSet.add(b));
    repos.push({ name: repo.name, branch, ahead, behind, dirty: lines.length, hasUp, files });
  }
  const branches = Array.from(branchSet).sort((a, b) => a.localeCompare(b));
  const current = currents.size === 1 ? Array.from(currents)[0] : '';
  post({ type: 'status', project: projectName, repos, branches, current });
}

// ---------------------------------------------------------------------------
//  CHECK / PULL main
// ---------------------------------------------------------------------------
async function runMain(kind, projectName) {
  const proj = findProject(projectName);
  if (!proj) { post({ type: 'log', level: 'err', text: 'Proyecto no encontrado' }); post({ type: 'done' }); return; }
  post({ type: 'busy' });
  post({ type: 'log', level: 'hdr', text: `== ${kind === 'check' ? 'CHECK MAIN' : 'PULL MAIN'} :: ${proj.name} ==` });

  let pending = 0, conflicts = 0;
  for (const repo of proj.repos) {
    const branch = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || '?';
    const tag = `${repo.name} (${branch})`;
    const dirty = await git(repo.path, ['status', '--porcelain']);
    if (dirty.out) { post({ type: 'log', level: 'warn', text: `${tag}: cambios sin commitear -> sin acciones` }); continue; }
    const main = await defaultBranch(repo.path);

    if (kind === 'check') {
      const f = await git(repo.path, ['fetch', 'origin', main, '--quiet']);
      if (f.code !== 0) { post({ type: 'log', level: 'err', text: `${tag}: no se pudo conectar al remoto` }); continue; }
      const behind = parseInt((await git(repo.path, ['rev-list', '--count', `HEAD..origin/${main}`])).out || '0', 10) || 0;
      if (behind <= 0) post({ type: 'log', level: 'ok', text: `${tag}: al dia con ${main}` });
      else {
        pending += behind;
        post({ type: 'log', level: 'warn', text: `${tag}: ${behind} commit(s) nuevo(s) en ${main} -> PULL PENDIENTE` });
        (await git(repo.path, ['log', `HEAD..origin/${main}`, '--oneline', '-10'])).out.split('\n').filter(Boolean)
          .forEach(l => post({ type: 'log', level: 'dim', text: '   ' + l }));
      }
    } else {
      const before = (await git(repo.path, ['rev-parse', 'HEAD'])).out;
      post({ type: 'log', level: 'dim', text: `${tag}: pull origin ${main}...` });
      const p = await git(repo.path, ['pull', 'origin', main, '--no-rebase']);
      if (p.code !== 0) { await git(repo.path, ['merge', '--abort']); conflicts++; post({ type: 'log', level: 'err', text: `${tag}: CONFLICTO - merge abortado` }); continue; }
      const commits = (await git(repo.path, ['log', `${before}..HEAD`, '--oneline'])).out.split('\n').filter(Boolean);
      if (commits.length === 0) post({ type: 'log', level: 'ok', text: `${tag}: ya estaba al dia` });
      else {
        post({ type: 'log', level: 'ok', text: `${tag}: integrados ${commits.length} commit(s)` });
        commits.slice(0, 10).forEach(l => post({ type: 'log', level: 'dim', text: '   ' + l }));
      }
    }
  }
  post({ type: 'log', level: 'hdr', text: kind === 'check'
    ? (pending > 0 ? `>> ${pending} commit(s) pendientes de pull` : '>> Todo al dia')
    : (conflicts > 0 ? `>> ${conflicts} repo(s) con conflicto` : '>> Pull completo') });
  post({ type: 'done' });
  await sendStatus(projectName);
}

// ---------------------------------------------------------------------------
//  COMMIT (add -A + commit) en cada repo con cambios
// ---------------------------------------------------------------------------
async function commitAction(projectName, message) {
  const proj = findProject(projectName);
  if (!proj) { post({ type: 'log', level: 'err', text: 'Proyecto no encontrado' }); post({ type: 'done' }); return; }
  if (!message || !message.trim()) { post({ type: 'log', level: 'err', text: 'Escribe un mensaje de commit' }); post({ type: 'done' }); return; }
  post({ type: 'busy' });
  post({ type: 'log', level: 'hdr', text: `== COMMIT :: ${proj.name} ==` });

  let done = 0;
  for (const repo of proj.repos) {
    const branch = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || '?';
    const tag = `${repo.name} (${branch})`;
    const st = await git(repo.path, ['status', '--porcelain']);
    if (!st.out) { post({ type: 'log', level: 'dim', text: `${tag}: nada que commitear` }); continue; }
    await git(repo.path, ['add', '-A']);
    const c = await git(repo.path, ['commit', '-m', message]);
    if (c.code !== 0) { post({ type: 'log', level: 'err', text: `${tag}: fallo commit - ${(c.err || c.out).split('\n')[0]}` }); continue; }
    done++;
    post({ type: 'log', level: 'ok', text: `${tag}: commit hecho` });
  }
  post({ type: 'log', level: 'hdr', text: done > 0 ? `>> ${done} repo(s) commiteados. Ahora puedes Push.` : '>> No habia cambios para commitear' });
  post({ type: 'done' });
  await sendStatus(projectName);
}

// ---------------------------------------------------------------------------
//  PUSH (crea upstream si falta)
// ---------------------------------------------------------------------------
async function pushAction(projectName) {
  const proj = findProject(projectName);
  if (!proj) { post({ type: 'log', level: 'err', text: 'Proyecto no encontrado' }); post({ type: 'done' }); return; }
  post({ type: 'busy' });
  post({ type: 'log', level: 'hdr', text: `== PUSH :: ${proj.name} ==` });

  for (const repo of proj.repos) {
    const branch = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || '?';
    const tag = `${repo.name} (${branch})`;
    const up = await git(repo.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    let p;
    if (up.code !== 0) {
      post({ type: 'log', level: 'dim', text: `${tag}: sin upstream, creando origin/${branch}...` });
      p = await git(repo.path, ['push', '-u', 'origin', branch]);
    } else {
      post({ type: 'log', level: 'dim', text: `${tag}: push...` });
      p = await git(repo.path, ['push']);
    }
    if (p.code !== 0) { post({ type: 'log', level: 'err', text: `${tag}: fallo push - ${(p.err || p.out).split('\n')[0]}` }); continue; }
    post({ type: 'log', level: 'ok', text: `${tag}: push OK` });
  }
  post({ type: 'log', level: 'hdr', text: '>> Push terminado' });
  post({ type: 'done' });
  await sendStatus(projectName);
}

// ---------------------------------------------------------------------------
//  CAMBIAR de rama (checkout) en cada repo que la tenga
// ---------------------------------------------------------------------------
async function switchBranch(projectName, branch) {
  const proj = findProject(projectName);
  if (!proj || !branch) { post({ type: 'done' }); return; }
  post({ type: 'busy' });
  post({ type: 'log', level: 'hdr', text: `== CAMBIAR A ${branch} :: ${proj.name} ==` });
  for (const repo of proj.repos) {
    const cur = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || '?';
    if (cur === branch) { post({ type: 'log', level: 'dim', text: `${repo.name}: ya estaba en ${branch}` }); continue; }
    const exists = await git(repo.path, ['rev-parse', '--verify', '--quiet', branch]);
    if (exists.code !== 0) { post({ type: 'log', level: 'dim', text: `${repo.name}: no tiene la rama ${branch}` }); continue; }
    const co = await git(repo.path, ['checkout', branch]);
    if (co.code !== 0) { post({ type: 'log', level: 'err', text: `${repo.name}: no se pudo cambiar - ${(co.err || co.out).split('\n')[0]}` }); continue; }
    post({ type: 'log', level: 'ok', text: `${repo.name}: ahora en ${branch}` });
  }
  post({ type: 'log', level: 'hdr', text: '>> Listo' });
  post({ type: 'done' });
  await sendStatus(projectName);
}

// ---------------------------------------------------------------------------
//  CREAR rama nueva (checkout -b) en cada repo
// ---------------------------------------------------------------------------
async function newBranch(projectName) {
  const proj = findProject(projectName);
  if (!proj) return;
  const name = await vscode.window.showInputBox({
    prompt: `Nombre de la nueva rama para ${proj.name}`,
    placeHolder: 'feature/mi-rama',
    validateInput: (v) => !v || !v.trim() ? 'Escribe un nombre' : (/\s/.test(v) ? 'Sin espacios' : null)
  });
  if (!name) return;
  const branch = name.trim();
  post({ type: 'busy' });
  post({ type: 'log', level: 'hdr', text: `== CREAR RAMA ${branch} :: ${proj.name} ==` });
  for (const repo of proj.repos) {
    const co = await git(repo.path, ['checkout', '-b', branch]);
    if (co.code !== 0) { post({ type: 'log', level: 'err', text: `${repo.name}: ${(co.err || co.out).split('\n')[0]}` }); continue; }
    post({ type: 'log', level: 'ok', text: `${repo.name}: creada y activa ${branch}` });
  }
  post({ type: 'log', level: 'hdr', text: '>> Rama creada. Recuerda Push para subirla.' });
  post({ type: 'done' });
  await sendStatus(projectName);
}

// ---------------------------------------------------------------------------
//  HTML del webview  (cozy vintage cafe)
// ---------------------------------------------------------------------------
function getHtml() {
  let fontCss = '';
  try { fontCss = fs.readFileSync(path.join(__dirname, 'media', 'fonts.css'), 'utf8'); } catch (e) {}
  try { fontCss += '\n' + fs.readFileSync(path.join(__dirname, 'media', 'mascot.css'), 'utf8'); } catch (e) {}
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  ${fontCss}
  :root {
    --green:#9caa6e; --amber:#d9a441; --cyan:#c96f4c; --pink:#b5533a; --muted:#b8a179;
    --ui:"Consolas","Cascadia Code","Courier New",monospace;
    --label:"Silkscreen","Courier New",monospace;
    --pix:"PressStart2P","Silkscreen",monospace;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body {
    margin:0; padding:12px; color:#ecd9b0; font-family:var(--ui); font-size:13px; overflow-x:hidden;
    background:
      radial-gradient(120% 90% at 50% -10%, #3a2a1a 0%, rgba(58,42,26,0) 60%),
      linear-gradient(#241a12, #1a1109);
  }
  body::before { /* textura suave tipo papel/tiza */
    content:""; position:fixed; inset:0; pointer-events:none;
    background-image:radial-gradient(rgba(255,240,210,.05) 1px, transparent 1px);
    background-size:15px 15px;
  }

  .cabinet {
    position:relative; border-radius:18px; padding:14px;
    background:linear-gradient(#2c2016,#231812);
    border:1px solid #5a4429;
    box-shadow:0 8px 22px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,240,210,.06);
  }

  .marquee { position:relative; display:flex; align-items:center; gap:10px; min-height:30px; margin:2px 0 14px; }
  .marquee .logo { width:38px; height:38px; flex:none; border-radius:50%;
    box-shadow:0 2px 3px rgba(0,0,0,.4), inset 0 0 0 1.5px rgba(58,40,20,.45); }
  .marquee h1 {
    margin:0; font-family:var(--pix); font-size:15px; font-weight:400; letter-spacing:0; line-height:1.1;
    color:#e0913a; text-shadow:2px 2px 0 #3a2410;
  }
  .pop { position:absolute; top:0; right:0; background:rgba(255,255,255,.04); border:1px solid #4a3620;
    color:var(--muted); border-radius:8px; cursor:pointer; font-size:13px; line-height:1; padding:5px 8px; }
  .pop:hover { color:var(--cyan); border-color:var(--cyan); box-shadow:0 0 10px rgba(201,111,76,.5); }

  label.lbl { display:block; font-family:var(--label); font-size:8px; letter-spacing:1px; color:var(--muted);
    text-transform:uppercase; margin:0 0 6px 2px; }
  select, input.msg {
    width:100%; background:#160f08; color:#ecd9b0; border:1px solid #4a3620;
    border-radius:9px; padding:8px 10px; font-family:var(--ui); font-size:13px; outline:none;
    box-shadow:inset 0 1px 4px rgba(0,0,0,.5);
  }
  select:focus, input.msg:focus { border-color:var(--cyan); box-shadow:0 0 0 1px var(--cyan),0 0 12px rgba(201,111,76,.35); }

  .status { margin:9px 0 2px; display:flex; flex-direction:column; gap:6px; }
  .srow { display:flex; align-items:center; gap:8px; border-radius:9px; padding:7px 10px; font-size:12px;
    background:linear-gradient(#241a10,#180f07); border:1px solid #3d2c18; flex-wrap:wrap;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.04); }
  .srow.has { cursor:pointer; }
  .srow .br { font-weight:800; color:#f5ecd8; display:flex; align-items:center; gap:6px; flex:1 1 auto;
    min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .srow .badges { display:flex; gap:5px; flex-wrap:wrap; align-items:center; }
  .srow .br .ico { color:var(--cyan); text-shadow:0 0 8px var(--cyan); }
  .srow .caret { color:var(--muted); font-size:9px; transition:transform .15s ease; }
  .srow.open .caret { transform:rotate(90deg); }
  .srow .repo { color:var(--muted); font-weight:400; font-size:11px; }
  .badge { font-family:var(--label); font-size:8px; padding:3px 7px; border-radius:20px; font-weight:400; letter-spacing:.3px; }
  .b-up{ color:#2a1400; background:var(--cyan); box-shadow:0 0 8px rgba(201,111,76,.6);}
  .b-dn{ color:#1a1000; background:var(--amber); box-shadow:0 0 8px rgba(255,176,31,.55);}
  .b-dirty{ color:#fff; background:var(--pink); box-shadow:0 0 8px rgba(255,90,69,.6);}
  .b-clean{ color:#161a04; background:var(--green); box-shadow:0 0 8px rgba(181,211,58,.55);}

  /* lista de archivos cambiados (desplegable) */
  .files { display:none; margin:-2px 0 0; padding:7px 11px; border-radius:8px;
    background:#1c1509; border:1px solid #3d2c18; font-family:"Cascadia Code","Consolas",monospace;
    font-size:11px; line-height:1.6; }
  .files.open { display:block; }
  .files .f { display:flex; gap:8px; align-items:center; }
  .files .c { width:20px; flex:none; font-weight:800; text-align:center; }
  .files .p { color:#d8c9a8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .c-mod{color:var(--amber);} .c-new{color:var(--cyan);} .c-del{color:var(--pink);} .c-add{color:#9bd24a;}

  /* barra de rama */
  .branchbar { display:flex; align-items:center; gap:8px; margin:10px 0 2px; }
  .branchbar .blabel { font-family:var(--label); font-size:8px; letter-spacing:1px; color:var(--muted); text-transform:uppercase; flex:none; }
  .branchbar select { flex:1; }
  .newbr { width:34px; height:34px; flex:none; border-radius:9px; border:1px solid #4a3620;
    background:rgba(255,255,255,.04); color:var(--cyan); font-size:20px; line-height:1; cursor:pointer;
    display:flex; align-items:center; justify-content:center; }
  .newbr:hover { border-color:var(--cyan); box-shadow:0 0 10px rgba(201,111,76,.45); }

  .section { margin-top:14px; }
  .section h4 { margin:0 0 9px; font-family:var(--label); font-size:8px; letter-spacing:1px; color:var(--muted);
    text-transform:uppercase; font-weight:400; text-align:center;
    display:flex; align-items:center; gap:10px; }
  .section h4::before, .section h4::after { content:""; flex:1; height:1px;
    background:linear-gradient(90deg,transparent,#4a3620,transparent); }

  /* botones tipo tarjeta con icono */
  .cards { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .cardbtn { display:flex; align-items:center; gap:10px; text-align:left; border:1px solid rgba(0,0,0,.18);
    border-radius:12px; padding:10px 11px; cursor:pointer; color:#2a1c08;
    box-shadow:0 3px 7px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.18);
    transition:transform .07s ease, filter .15s ease; }
  .cardbtn .ic { width:28px; height:28px; flex:none; border-radius:9px; display:flex; align-items:center; justify-content:center;
    background:rgba(0,0,0,.16); }
  .cardbtn .ic svg { width:15px; height:15px; stroke:currentColor; }
  .cardbtn .tx { display:flex; flex-direction:column; line-height:1.1; min-width:0; }
  .cardbtn .tx b { font-family:var(--label); font-size:11px; font-weight:400; letter-spacing:.3px; }
  .cardbtn .tx small { font-size:9.5px; opacity:.82; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cardbtn:hover { filter:brightness(1.06); }
  .cardbtn:active { transform:translateY(2px); }
  .cardbtn:disabled { filter:grayscale(.5) brightness(.6); cursor:not-allowed; }
  .c-check { background:linear-gradient(#5a8a4a,#436b37); color:#f0fbe6; }
  .c-pull  { background:linear-gradient(#3a2c1e,#2c2016); color:#f0dcae; border-color:#5a4429; }
  .c-commit{ background:linear-gradient(#e6b155,#cf922f); color:#3a2408; }
  .c-push  { background:linear-gradient(#cf6a52,#b5533a); color:#fff2ec; }

  .msgwrap { margin:0 0 12px; }

  .screen { margin-top:14px; background:#1b130b; border:1px solid #5a4429; border-radius:10px; height:120px;
    overflow-y:auto; padding:9px 11px; font-size:12px; line-height:1.5;
    font-family:"Courier New","Cascadia Code",monospace; color:#ecd9b0;
    box-shadow:inset 0 2px 10px rgba(0,0,0,.5), 0 0 0 1px #33261a;
    text-shadow:0 1px 0 rgba(0,0,0,.4); }
  .screen div { white-space:pre-wrap; word-break:break-word; }
  /* mascota de bienvenida (taza de cafe) */
  .mascot { display:flex; align-items:center; gap:12px; height:100%; }
  .mimg { background-color:#f4ead2; background-size:cover; background-position:center; background-repeat:no-repeat; }
  .bot { width:66px; height:66px; flex:none; border-radius:13px;
    box-shadow:0 3px 6px rgba(0,0,0,.4), inset 0 0 0 1.5px rgba(58,40,20,.4);
    animation:bob 3s ease-in-out infinite; }
  @keyframes bob { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-3px);} }
  .bubble { position:relative; background:#2e2216; border:1px solid #5a4429; border-radius:12px;
    padding:10px 12px; font-family:var(--ui); font-size:13px; line-height:1.5; color:#ecd9b0;
    text-shadow:none; flex:1; }
  .bubble b { color:#e6b45a; font-weight:700; }
  .bubble::before { content:""; position:absolute; left:-8px; top:50%; transform:translateY(-50%);
    border:8px solid transparent; border-right-color:#5a4429; }
  .bubble::after { content:""; position:absolute; left:-6px; top:50%; transform:translateY(-50%);
    border:7px solid transparent; border-right-color:#2e2216; }
  .ok{color:#a7b877;} .warn{color:var(--amber);} .err{color:#d1795a;}
  .dim{color:#a8926c;} .hdr{color:#e0a35c;font-weight:700;} .info{color:#e8dcc4;}

  .foot { display:flex; justify-content:space-between; align-items:center; margin-top:9px; }
  .foot button { background:rgba(255,255,255,.03); border:1px solid #4a3620; color:var(--muted); border-radius:7px;
    padding:6px 10px; font-family:var(--label); font-size:8px; letter-spacing:1px; cursor:pointer; text-transform:uppercase; }
  .foot button:hover { border-color:var(--cyan); color:var(--cyan); box-shadow:0 0 10px rgba(201,111,76,.4); }
</style>
</head>
<body>
  <div class="cabinet">
    <div class="marquee">
      <div class="logo mimg"></div>
      <h1>GIT CAF&Eacute;</h1>
      <button class="pop" id="popout" title="Abrir en ventana flotante">&#10530;</button>
    </div>

    <label class="lbl">Proyecto</label>
    <select id="project"></select>

    <div class="status" id="status"></div>

    <div class="branchbar" id="branchbar" style="display:none;">
      <span class="blabel">Rama</span>
      <select id="branchsel"></select>
      <button class="newbr" id="newbranch" title="Crear rama nueva">&#43;</button>
    </div>

    <div class="section">
      <h4>Sincronizar main</h4>
      <div class="cards">
        <button class="cardbtn c-check" id="check"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span class="tx"><b>Check</b><small>fetch &amp; avisa</small></span></button>
        <button class="cardbtn c-pull" id="pull"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-5-5m5 5l5-5M5 21h14"/></svg></span><span class="tx"><b>Pull</b><small>integra main</small></span></button>
      </div>
    </div>

    <div class="section">
      <h4>Tu trabajo</h4>
      <div class="msgwrap"><input class="msg" id="msg" placeholder="mensaje de commit..." maxlength="200"></div>
      <div class="cards">
        <button class="cardbtn c-commit" id="commit"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/></svg></span><span class="tx"><b>Commit</b><small>guarda cambios</small></span></button>
        <button class="cardbtn c-push" id="push"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9m0 0l-5 5m5-5l5 5M5 3h14"/></svg></span><span class="tx"><b>Push</b><small>sube a GitHub</small></span></button>
      </div>
    </div>

    <div class="screen" id="screen">
      <div class="mascot">
        <div class="bot mimg"></div>
        <div class="bubble">Buenas &#9749; Elige un <b>proyecto</b> y te digo en qu&eacute; <b>rama</b> andas.</div>
      </div>
    </div>

    <div class="foot">
      <button id="rescan">&#8635; Re-escanear</button>
      <button id="refresh">&#8635; Estado</button>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const screen = $('screen'), sel = $('project'), statusEl = $('status'), msg = $('msg');
  let projects = [];

  function line(text, level){ const d=document.createElement('div'); d.className=level||'info'; d.textContent=text;
    screen.appendChild(d); screen.scrollTop=screen.scrollHeight; }
  function clearScreen(){ screen.innerHTML=''; }
  function setBusy(b){ ['check','pull','commit','push'].forEach(id=>$(id).disabled=b); sel.disabled=b; }
  function requestStatus(){ if(sel.value){ statusEl.innerHTML='<div class="srow"><span class="repo">cargando estado...</span></div>'; vscode.postMessage({cmd:'status', project:sel.value}); } }

  function fileClass(code){
    const c=(code||'').trim();
    if(c.indexOf('?')>=0) return 'c-new';
    if(c.indexOf('D')>=0) return 'c-del';
    if(c.indexOf('A')>=0) return 'c-add';
    return 'c-mod';
  }

  function renderBranchBar(branches, current){
    const bar=$('branchbar'), bsel=$('branchsel');
    if(!branches || !branches.length){ bar.style.display='none'; return; }
    bar.style.display='flex';
    bsel.innerHTML='';
    if(!current){ const o=document.createElement('option'); o.value=''; o.textContent='(varias ramas)'; bsel.appendChild(o); }
    branches.forEach(b=>{ const o=document.createElement('option'); o.value=b; o.textContent=b; if(b===current)o.selected=true; bsel.appendChild(o); });
  }

  function renderStatus(p, repos, branches, current){
    if(sel.value!==p) return;
    renderBranchBar(branches, current);
    statusEl.innerHTML='';
    repos.forEach(r=>{
      const hasFiles = r.files && r.files.length;
      const row=document.createElement('div'); row.className='srow'+(hasFiles?' has':'');
      const multi = repos.length>1 ? '<span class="repo">'+r.name+'</span>' : '';
      const caret = hasFiles ? '<span class="caret">&#9656;</span>' : '';
      let badges='';
      if(r.dirty>0) badges+='<span class="badge b-dirty">'+r.dirty+' cambios</span>';
      else badges+='<span class="badge b-clean">limpio</span>';
      if(r.ahead>0) badges+=' <span class="badge b-up">&#8593;'+r.ahead+'</span>';
      if(r.behind>0) badges+=' <span class="badge b-dn">&#8595;'+r.behind+'</span>';
      row.innerHTML='<span class="br"><span class="ico">&#9095;</span>'+r.branch+' '+multi+caret+'</span><span class="badges">'+badges+'</span>';
      statusEl.appendChild(row);
      if(hasFiles){
        const fl=document.createElement('div'); fl.className='files';
        r.files.forEach(f=>{
          const div=document.createElement('div'); div.className='f';
          const c=document.createElement('span'); c.className='c '+fileClass(f.code); c.textContent=(f.code||'').trim()||'M';
          const pth=document.createElement('span'); pth.className='p'; pth.textContent=f.path;
          div.appendChild(c); div.appendChild(pth); fl.appendChild(div);
        });
        statusEl.appendChild(fl);
        row.addEventListener('click', ()=>{ row.classList.toggle('open'); fl.classList.toggle('open'); });
      }
    });
  }

  sel.addEventListener('change', requestStatus);
  $('branchsel').addEventListener('change', ()=>{ const b=$('branchsel').value; if(!sel.value||!b)return; clearScreen(); vscode.postMessage({cmd:'switch', project:sel.value, branch:b}); });
  $('newbranch').addEventListener('click', ()=>{ if(!sel.value)return; vscode.postMessage({cmd:'newbranch', project:sel.value}); });
  $('check').addEventListener('click', ()=>{ if(!sel.value)return; clearScreen(); vscode.postMessage({cmd:'check', project:sel.value}); });
  $('pull').addEventListener('click', ()=>{ if(!sel.value)return; clearScreen(); vscode.postMessage({cmd:'pull', project:sel.value}); });
  $('commit').addEventListener('click', ()=>{ if(!sel.value)return; if(!msg.value.trim()){ clearScreen(); line('Escribe un mensaje de commit','err'); msg.focus(); return; } clearScreen(); vscode.postMessage({cmd:'commit', project:sel.value, message:msg.value.trim()}); msg.value=''; });
  $('push').addEventListener('click', ()=>{ if(!sel.value)return; clearScreen(); vscode.postMessage({cmd:'push', project:sel.value}); });
  $('rescan').addEventListener('click', ()=>vscode.postMessage({cmd:'rescan'}));
  $('refresh').addEventListener('click', requestStatus);
  $('popout').addEventListener('click', ()=>vscode.postMessage({cmd:'popout'}));

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
    } else if(m.type==='status'){ renderStatus(m.project, m.repos, m.branches, m.current);
    } else if(m.type==='busy'){ setBusy(true);
    } else if(m.type==='done'){ setBusy(false);
    } else if(m.type==='log'){ line(m.text, m.level); }
  });

  vscode.postMessage({cmd:'ready'});
</script>
</body>
</html>`;
}

module.exports = { activate, deactivate };
