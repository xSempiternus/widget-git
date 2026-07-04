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
  statusItem.text = '$(coffee) Brew';
  statusItem.tooltip = 'Abrir Brew (rama / commit / push / main)';
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
    --bg1:#1d130d; --bg2:#100b08;
    --surfA:#241811; --surfB:#201510; --surfC:#19110b;
    --bd1:#3a281b; --bd2:#43301f; --bd3:#38271a; --bd4:#33241a;
    --amber:#e0912f; --green:#a6cf8f; --terra:#cf6b42;
    --txt:#f0e2cc; --txt2:#d8c4a4; --mut:#8f7657; --lab:#b98a52; --acc:#c9a877;
    --sans:"Space Grotesk",system-ui,sans-serif;
    --mono:"IBM Plex Mono",ui-monospace,monospace;
    --brand:"Bungee",var(--sans);
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body {
    margin:0; padding:14px; color:var(--txt); font-family:var(--sans); font-size:13px; overflow-x:hidden;
    background:radial-gradient(120% 80% at 50% -5%, #2a1a10 0%, rgba(42,26,16,0) 55%), var(--bg2);
  }

  .panel {
    position:relative; border-radius:18px; padding:18px; display:flex; flex-direction:column; gap:13px;
    background:linear-gradient(160deg,var(--bg1),var(--bg2)); border:1px solid var(--bd1);
    box-shadow:0 0 0 1px var(--bd1), 0 12px 34px -10px rgba(0,0,0,.75), 0 0 24px -4px rgba(224,145,47,.5), 0 0 64px -14px rgba(224,145,47,.35);
  }

  .header { display:flex; align-items:center; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:10px; }
  .logo { width:34px; height:34px; flex:none; filter:drop-shadow(0 0 6px rgba(224,145,47,.4)); }
  .wordmark { font-family:var(--brand); font-size:19px; line-height:1; color:#f7ecd4;
    text-shadow:0 0 8px rgba(224,145,47,.75),0 0 18px rgba(224,145,47,.35); animation:flick 4s infinite; }
  @keyframes flick { 0%,96%,100%{opacity:1;} 98%{opacity:.85;} }
  .expand { width:32px; height:32px; flex:none; border:1px solid var(--bd1); border-radius:9px; background:transparent;
    color:var(--acc); cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .expand:hover { border-color:var(--amber); color:var(--amber); box-shadow:0 0 10px -2px rgba(224,145,47,.6); }
  .expand svg { width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:1.6; }
  .mimg-head,.mimg-full { background-size:contain; background-position:center; background-repeat:no-repeat; }

  .field { display:flex; flex-direction:column; gap:6px; }
  .lbl { font-family:var(--mono); font-size:10px; font-weight:600; letter-spacing:.18em; text-transform:uppercase; color:var(--lab); }
  select, .input {
    width:100%; font-family:var(--sans); font-size:13px; font-weight:500; color:var(--txt);
    background:var(--surfA); border:1px solid var(--bd2); border-radius:10px; padding:9px 12px; outline:none;
  }
  select { appearance:none; -webkit-appearance:none; padding-right:30px; cursor:pointer;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M0 0L5 6L10 0z' fill='%23b98a52'/></svg>");
    background-repeat:no-repeat; background-position:right 12px center; }
  .input::placeholder { color:#7a6144; }
  select:focus, .input:focus { border-color:rgba(224,145,47,.6); box-shadow:0 0 0 1px rgba(224,145,47,.4); }

  .status { display:flex; flex-direction:column; gap:8px; }
  .srow { display:flex; align-items:center; gap:10px; flex-wrap:wrap; background:var(--surfB);
    border:1px solid var(--bd3); border-radius:10px; padding:8px 10px 8px 12px; font-family:var(--mono); font-size:13px; }
  .srow.has { cursor:pointer; }
  .srow .br { display:flex; align-items:center; gap:7px; flex:1 1 auto; min-width:0; color:var(--txt); font-weight:500;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .srow .br .ico { color:#c98b4a; }
  .srow .caret { color:var(--mut); font-size:10px; transition:transform .15s ease; }
  .srow.open .caret { transform:rotate(90deg); }
  .srow .repo { color:var(--mut); font-size:11px; }
  .srow .badges { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .badge { font-family:var(--mono); font-size:10px; font-weight:600; padding:3px 9px; border-radius:999px; }
  .b-clean{ color:var(--green); background:rgba(126,168,116,.14); border:1px solid rgba(126,168,116,.5); box-shadow:0 0 10px -2px rgba(126,168,116,.6);}
  .b-dirty{ color:#f0b88a; background:rgba(224,145,47,.14); border:1px solid rgba(224,145,47,.5);}
  .b-up{ color:#f0d8a0; background:rgba(224,145,47,.14); border:1px solid rgba(224,145,47,.4);}
  .b-dn{ color:#e6b48a; background:rgba(207,107,66,.16); border:1px solid rgba(207,107,66,.45);}

  /* lista de archivos cambiados (desplegable) */
  .files { display:none; padding:8px 11px; border-radius:8px; background:var(--surfC); border:1px solid var(--bd4);
    font-family:var(--mono); font-size:11px; line-height:1.7; margin-top:-2px; }
  .files.open { display:block; }
  .files .f { display:flex; gap:8px; align-items:center; }
  .files .c { width:20px; flex:none; font-weight:700; text-align:center; }
  .files .p { color:var(--txt2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .c-mod{color:var(--amber);} .c-new{color:var(--green);} .c-del{color:var(--terra);} .c-add{color:var(--green);}

  /* barra de rama (label + select + boton +) */
  .branchbar { display:flex; align-items:center; gap:8px; }
  .branchbar .blabel { font-family:var(--mono); font-size:10px; font-weight:600; letter-spacing:.18em; text-transform:uppercase; color:var(--lab); flex:none; }
  .branchbar select { flex:1; }
  .newbr { width:38px; height:38px; flex:none; border:1px solid var(--bd2); border-radius:10px; background:var(--surfA);
    color:var(--amber); font-size:20px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .newbr:hover { box-shadow:0 0 10px -3px rgba(224,145,47,.7); border-color:rgba(224,145,47,.5); }

  /* divisor */
  .divider { display:flex; align-items:center; gap:10px; }
  .divider::before,.divider::after { content:""; flex:1; height:1px; background:linear-gradient(90deg,transparent,var(--bd1)); }
  .divider::after { background:linear-gradient(90deg,var(--bd1),transparent); }
  .divider span { font-family:var(--mono); font-size:9px; font-weight:600; letter-spacing:.2em; text-transform:uppercase; color:var(--mut); }

  /* botones tarjeta */
  .cards { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .cardbtn { display:flex; align-items:center; gap:10px; text-align:left; border-radius:11px; padding:10px 11px; cursor:pointer;
    border:1px solid transparent; transition:transform .07s ease, box-shadow .2s ease, filter .2s ease; }
  .cardbtn .ic { width:28px; height:28px; flex:none; border-radius:8px; display:flex; align-items:center; justify-content:center; }
  .cardbtn .ic svg { width:15px; height:15px; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .cardbtn .tx { display:flex; flex-direction:column; min-width:0; line-height:1.15; }
  .cardbtn .tx b { font-family:var(--sans); font-size:12px; }
  .cardbtn .tx small { font-family:var(--mono); font-size:9px; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cardbtn:active { transform:translateY(1px); }
  .cardbtn:disabled { filter:grayscale(.5) brightness(.65); cursor:not-allowed; }
  .c-check { background:#1c2419; border-color:rgba(126,168,116,.4); color:#a6cf8f; }
  .c-check .ic { background:rgba(126,168,116,.14); } .c-check .tx b { color:#e7f2df; } .c-check .tx small { color:#7fa06f; }
  .c-pull { background:#251a10; border-color:rgba(224,145,47,.4); color:#e0912f; }
  .c-pull .ic { background:rgba(224,145,47,.14); } .c-pull .tx b { color:#f4e6c8; } .c-pull .tx small { color:#b98a52; }
  .c-check:hover,.c-pull:hover { filter:brightness(1.12); }
  .c-commit { background:linear-gradient(150deg,#e6982f,#c8781f); color:#2a1503; box-shadow:0 0 16px -4px rgba(224,145,47,.7); }
  .c-commit .ic { background:rgba(0,0,0,.14); } .c-commit .tx b { font-weight:700; } .c-commit .tx small { color:#2a1503; opacity:.75; }
  .c-push { background:linear-gradient(150deg,#cf6b42,#b1502f); color:#fbeadf; box-shadow:0 0 16px -4px rgba(207,107,66,.6); }
  .c-push .ic { background:rgba(0,0,0,.14); } .c-push .tx b { font-weight:700; } .c-push .tx small { color:#fbeadf; opacity:.8; }
  .c-commit:hover { box-shadow:0 0 20px -3px rgba(224,145,47,.85); } .c-push:hover { box-shadow:0 0 20px -3px rgba(207,107,66,.75); }

  /* burbuja mascota + feedback */
  .bubble { display:flex; gap:10px; background:var(--surfC); border:1px solid var(--bd4); border-left:3px solid var(--amber);
    border-radius:12px; padding:11px 12px; }
  .bot { width:44px; height:44px; flex:none; align-self:flex-start; animation:bob 3.4s ease-in-out infinite; }
  @keyframes bob { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-2px);} }
  .screen { flex:1; min-width:0; max-height:90px; overflow-y:auto; font-family:var(--sans); font-size:12.5px; line-height:1.45; color:var(--txt2); }
  .screen div { white-space:pre-wrap; word-break:break-word; }
  .screen .greet b, .info b { color:var(--amber); }
  .ok{color:var(--green);} .warn{color:var(--amber);} .err{color:var(--terra);}
  .dim{color:var(--mut);} .hdr{color:#e0a35c;font-weight:600;} .info{color:var(--txt2);}
  .mono { font-family:var(--mono); }

  .ghostrow { display:flex; gap:10px; }
  .ghost { flex:1; display:flex; align-items:center; justify-content:center; gap:7px; border:1px solid var(--bd1); border-radius:10px;
    background:transparent; color:var(--acc); font-family:var(--mono); font-size:10px; font-weight:600; letter-spacing:.1em;
    text-transform:uppercase; padding:8px 10px; cursor:pointer; }
  .ghost:hover { border-color:var(--amber); color:var(--amber); }
  .ghost svg { width:13px; height:13px; stroke:currentColor; fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
</style>
</head>
<body>
  <div class="panel">
    <div class="header">
      <div class="brand">
        <div class="logo mimg-head"></div>
        <div class="wordmark">Brew</div>
      </div>
      <button class="expand" id="popout" title="Abrir en ventana flotante">
        <svg viewBox="0 0 20 20"><path d="M8 3H3v5M12 17h5v-5M3 3l6 6M17 17l-6-6"/></svg>
      </button>
    </div>

    <div class="field">
      <label class="lbl">Proyecto</label>
      <select id="project"></select>
    </div>

    <div class="status" id="status"></div>

    <div class="branchbar" id="branchbar" style="display:none;">
      <span class="blabel">Rama</span>
      <select id="branchsel"></select>
      <button class="newbr" id="newbranch" title="Crear rama nueva">&#43;</button>
    </div>

    <div class="divider"><span>Sincronizar main</span></div>

    <div class="cards">
      <button class="cardbtn c-check" id="check"><span class="ic"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></span><span class="tx"><b>Check</b><small>fetch &amp; avisa</small></span></button>
      <button class="cardbtn c-pull" id="pull"><span class="ic"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-5-5m5 5l5-5M5 21h14"/></svg></span><span class="tx"><b>Pull</b><small>integra main</small></span></button>
    </div>

    <div class="field">
      <label class="lbl">Tu trabajo</label>
      <input class="input" id="msg" placeholder="mensaje de commit&hellip;" maxlength="200">
    </div>

    <div class="cards">
      <button class="cardbtn c-commit" id="commit"><span class="ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/></svg></span><span class="tx"><b>Commit</b><small>guarda cambios</small></span></button>
      <button class="cardbtn c-push" id="push"><span class="ic"><svg viewBox="0 0 24 24"><path d="M12 21V9m0 0l-5 5m5-5l5 5M5 3h14"/></svg></span><span class="tx"><b>Push</b><small>sube a GitHub</small></span></button>
    </div>

    <div class="bubble">
      <div class="bot mimg-full"></div>
      <div class="screen" id="screen"><div class="greet">Buenas &#9749; Elige un <b>proyecto</b> y te digo en qu&eacute; <b>rama</b> andas.</div></div>
    </div>

    <div class="ghostrow">
      <button class="ghost" id="rescan"><svg viewBox="0 0 20 20"><path d="M3 10a7 7 0 0 1 12-5l2 2M17 10a7 7 0 0 1-12 5l-2-2M15 3v4h-4M5 17v-4h4"/></svg>Re-escanear</button>
      <button class="ghost" id="refresh"><svg viewBox="0 0 20 20"><path d="M6 3h8v14H6zM8 6h4M8 9h4M8 12h3"/></svg>Estado</button>
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
