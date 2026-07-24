const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BREW_SCHEME = 'brew-git';   // esquema virtual para mostrar la version en HEAD dentro del diff
const targets = new Set();   // webviews vivos (vista fijada + ventana flotante)
let statusItem = null;
let cachedProjects = null;
let cacheTime = 0;                       // cuando se construyo cachedProjects (para el TTL)
const PROJECTS_TTL = 60000;              // re-escanea repos nuevos sin rescan manual pasado 1 min
const defaultBranchCache = new Map();    // rama principal por repo (rara vez cambia)
function invalidateCache() { cachedProjects = null; defaultBranchCache.clear(); }
let currentProject = null;   // proyecto seleccionado ahora mismo (para el auto-refresco)
let headWatchers = [];       // fs.watch sobre cada .git para detectar cambios de rama externos
let headDebounce = null;
let suppressWatchUntil = 0;  // ignora eventos de watch provocados por nuestras propias operaciones

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
      webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { sendProjects(); autoSelect(); } });
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
    vscode.commands.registerCommand('gitArcade.setBackground', setBackgroundFlow),
    vscode.commands.registerCommand('gitArcade.clearBackground', clearBackgroundFlow),
    vscode.commands.registerCommand('gitArcade.rescan', () => {
      invalidateCache(); sendProjects();
      vscode.window.showInformationMessage('GIT ARCADE: proyectos re-escaneados.');
    })
  );

  // si cambia la config del fondo (desde Ajustes), refresca los webviews en caliente
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('gitArcade.backgroundImage') || e.affectsConfiguration('gitArcade.backgroundOpacity')) sendBackground();
    })
  );

  // --- Sincronizacion con VSCode ---
  // al cambiar el editor o las carpetas del workspace, auto-selecciona el proyecto que toca
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => autoSelect()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { invalidateCache(); autoSelect(); }),
    // refresco en vivo del estado "sin commitear" al guardar/crear/borrar/renombrar archivos
    vscode.workspace.onDidSaveTextDocument(doc => onWorkspaceFileChange(doc.uri)),
    vscode.workspace.onDidCreateFiles(e => e.files.forEach(onWorkspaceFileChange)),
    vscode.workspace.onDidDeleteFiles(e => e.files.forEach(onWorkspaceFileChange)),
    vscode.workspace.onDidRenameFiles(e => e.files.forEach(f => onWorkspaceFileChange(f.newUri))),
    // provee el contenido "HEAD" de un archivo para el diff (git show), sin depender de que el repo este abierto
    vscode.workspace.registerTextDocumentContentProvider(BREW_SCHEME, brewDiffProvider),
    { dispose: disposeHeadWatchers }
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
    // al iniciar una operacion que modifica algo, limpia la bandera de cancelacion
    if (['check', 'pull', 'commit', 'push', 'switch', 'newbranch', 'suggest'].includes(msg.cmd)) opCancelled = false;
    if (msg.cmd === 'switch' || msg.cmd === 'newbranch') suppressWatchUntil = Date.now() + 2500;
    switch (msg.cmd) {
      case 'ready': sendProjects(); autoSelect(); sendBackground(); break;
      case 'rescan': invalidateCache(); sendProjects(); autoSelect(); break;
      case 'setbg': await setBackgroundFlow(); break;
      case 'bgImage': await pickBackgroundImage(); break;
      case 'bgReset': await clearBackgroundFlow(); break;
      case 'bgOpacity': await setBackgroundOpacity(msg.value); break;
      case 'status': await sendStatus(msg.project); break;
      case 'select': await selectProject(msg.project); break;
      case 'check': await runMain('check', msg.project, msg.repos); break;
      case 'pull': await runMain('pull', msg.project, msg.repos); break;
      case 'commit': await commitAction(msg.project, msg.message, msg.repos); break;
      case 'suggest': await suggestMessage(msg.project, msg.repos); break;
      case 'push': await pushAction(msg.project, msg.repos); break;
      case 'switch': await switchBranch(msg.project, msg.branch); break;
      case 'newbranch': await newBranch(msg.project); break;
      case 'opendiff': await openDiff(msg.project, msg.repo, msg.path, msg.code); break;
      case 'cancel': cancelOp(); break;
      case 'popout': openPopout(); break;
    }
  } catch (e) {
    post({ type: 'log', level: 'err', text: 'ERROR: ' + (e && e.message ? e.message : String(e)) });
    post({ type: 'done' });
  }
}

function post(m) { for (const wv of targets) wv.postMessage(m); }

// ---------------------------------------------------------------------------
//  Fondo del panel (imagen por defecto o personalizada + intensidad), en config
// ---------------------------------------------------------------------------
// El webview no puede leer rutas arbitrarias del disco: embebemos la imagen como
// data-URI base64. Devuelve '' si falla (CSP permite img-src data:).
function imageDataUri(file) {
  try {
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif'
      : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp'
      : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) { return ''; }
}
// intensidad de la imagen (0 = oculta, 1 = plena). Por defecto sutil.
function bgOpacity() {
  let p = Number(cfg('backgroundOpacity', 0.10));
  if (!isFinite(p)) p = 0.10;
  return Math.max(0, Math.min(1, p));
}
// a mayor visibilidad de la imagen, menor velo oscuro encima.
function veilFor(p) { return Math.max(0.3, Math.min(0.97, 1 - p)).toFixed(3); }
// imagen vigente: la personalizada si existe y es valida; si no, la de por defecto.
function currentBgUri() {
  const custom = cfg('backgroundImage', '');
  if (custom) { const u = imageDataUri(custom); if (u) return u; }
  return imageDataUri(path.join(__dirname, 'media', 'background.jpg'));
}
// empuja el fondo vigente a todos los webviews vivos (en caliente, sin recargar).
function sendBackground() { post({ type: 'background', uri: currentBgUri(), opacity: bgOpacity() }); }

// Menu (paleta de comandos / icono): elegir imagen, ajustar intensidad o restaurar.
async function setBackgroundFlow() {
  const pct = Math.round(bgOpacity() * 100);
  const pick = await vscode.window.showQuickPick(
    [ { label: '$(file-media)  Elegir imagen...', id: 'choose' },
      { label: '$(color-mode)  Ajustar intensidad...', id: 'opacity', description: `actual: ${pct}%` },
      { label: '$(discard)  Restaurar fondo por defecto', id: 'reset' } ],
    { placeHolder: 'Fondo del panel Brew' });
  if (!pick) return;
  if (pick.id === 'opacity') { await adjustOpacityFlow(); return; }
  if (pick.id === 'reset') { await clearBackgroundFlow(); return; }
  await pickBackgroundImage();
}

// Abre el selector de archivos y fija la imagen elegida como fondo (via config).
async function pickBackgroundImage() {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false, openLabel: 'Usar como fondo',
    filters: { 'Imagenes': ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }
  });
  if (!uris || !uris.length) return;
  const fsPath = uris[0].fsPath;
  try {
    const size = fs.statSync(fsPath).size;
    if (size > 6 * 1024 * 1024) {
      const go = await vscode.window.showWarningMessage(
        `La imagen pesa ${(size / 1048576).toFixed(1)} MB y puede ralentizar el panel. Usarla igual?`, 'Si', 'No');
      if (go !== 'Si') return;
    }
  } catch (e) {}
  await vscode.workspace.getConfiguration('gitArcade').update('backgroundImage', fsPath, vscode.ConfigurationTarget.Global);
  sendBackground();
}

async function clearBackgroundFlow() {
  const conf = vscode.workspace.getConfiguration('gitArcade');
  await conf.update('backgroundImage', '', vscode.ConfigurationTarget.Global);
  await conf.update('backgroundOpacity', 0.10, vscode.ConfigurationTarget.Global);
  sendBackground();
}

// Guarda la intensidad (desde el slider del panel). Se persiste en config.
async function setBackgroundOpacity(value) {
  let v = Number(value); if (!isFinite(v)) return;
  v = Math.max(0, Math.min(1, v));
  await vscode.workspace.getConfiguration('gitArcade').update('backgroundOpacity', v, vscode.ConfigurationTarget.Global);
  sendBackground();
}

// Ajusta la intensidad con vista previa EN VIVO (paleta): recorrer = preview, Enter guarda, Esc revierte.
function adjustOpacityFlow() {
  const conf = vscode.workspace.getConfiguration('gitArcade');
  const cur = bgOpacity();
  const levels = [
    { label: 'Apagado (solo color)', v: 0 },
    { label: 'Muy sutil',            v: 0.08 },
    { label: 'Sutil (recomendado)',  v: 0.14 },
    { label: 'Media',                v: 0.25 },
    { label: 'Visible',              v: 0.40 },
  ];
  const uri = currentBgUri();  // se codifica una vez y se reutiliza en cada preview
  const qp = vscode.window.createQuickPick();
  qp.title = 'Intensidad del fondo';
  qp.placeholder = 'Vista previa en vivo — Enter para guardar, Esc para cancelar';
  qp.items = levels.map(l => ({ label: (Math.abs(l.v - cur) < 0.001 ? '$(check) ' : '') + l.label, description: Math.round(l.v * 100) + '%', v: l.v }));
  const active = qp.items.filter(i => Math.abs(i.v - cur) < 0.001);
  if (active.length) qp.activeItems = active;
  let chosen = cur;
  qp.onDidChangeActive(items => { if (items && items[0]) { chosen = items[0].v; post({ type: 'background', uri, opacity: chosen }); } });
  return new Promise(resolve => {
    let saved = false;
    qp.onDidAccept(async () => { saved = true; await conf.update('backgroundOpacity', chosen, vscode.ConfigurationTarget.Global); qp.hide(); });
    qp.onDidHide(() => { qp.dispose(); if (!saved) sendBackground(); resolve(); });  // Esc: revierte al valor guardado
    qp.show();
  });
}

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
  if (cachedProjects && (Date.now() - cacheTime) < PROJECTS_TTL) return cachedProjects;
  const maxDepth = cfg('scanDepth', 4);
  const rootPath = cfg('rootPath', path.join(os.homedir(), 'Documents', 'PROJECTS'));
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
  cacheTime = Date.now();
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
let activeChild = null;      // proceso git en curso (para poder cancelarlo)
let opCancelled = false;     // el usuario cancelo la operacion actual?
let activeLmCancel = null;   // cancela la peticion al modelo de IA (sugerencia de commit)

function git(cwd, args) {
  return new Promise((resolve) => {
    const child = cp.spawn('git', args, { cwd, windowsHide: true });
    activeChild = child;
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', e => { if (activeChild === child) activeChild = null; resolve({ code: -1, out: '', err: e.message }); });
    child.on('close', code => { if (activeChild === child) activeChild = null; resolve({ code, out: out.trim(), err: err.trim() }); });
  });
}

// Lee el contenido de un archivo en una referencia (git show <ref>:<path>) SIN recortar,
// para mostrarlo intacto en el diff. Funciona para cualquier repo, este abierto o no.
function gitShowRaw(cwd, ref, relPath) {
  return new Promise((resolve) => {
    if (ref === '__EMPTY__') return resolve('');
    const child = cp.spawn('git', ['--no-pager', 'show', `${ref}:${relPath}`], { cwd, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => out += d.toString());
    child.on('error', () => resolve(''));
    child.on('close', code => resolve(code === 0 ? out : ''));
  });
}

// Provee el contenido "HEAD" (o vacio) de un archivo para el editor de diff nativo.
const brewDiffProvider = {
  provideTextDocumentContent(uri) {
    let q; try { q = JSON.parse(uri.query || '{}'); } catch (e) { return ''; }
    if (!q.repo) return '';
    return gitShowRaw(q.repo, q.ref || 'HEAD', q.path || '');
  }
};

// URI virtual (brew-git:) que el provider de arriba resuelve a la version en <ref>.
function brewUri(repoPath, ref, relPath) {
  return vscode.Uri.from({ scheme: BREW_SCHEME, path: '/' + relPath, query: JSON.stringify({ repo: repoPath, ref, path: relPath }) });
}

// Cancela la operacion en curso: mata el proceso git activo y marca la bandera.
function cancelOp() {
  opCancelled = true;
  if (activeChild) { try { activeChild.kill(); } catch (e) {} }
  if (activeLmCancel) { try { activeLmCancel.cancel(); } catch (e) {} }
  post({ type: 'log', level: 'warn', text: '>> Cancelando operacion...' });
}

// Tras matar un git a mitad de un commit/merge puede quedar un .git/index.lock huerfano
// que bloquea las siguientes operaciones. Lo limpia (solo se llama al cancelar, sin git vivo).
function cleanupLocks(repos) {
  for (const r of repos) {
    const lock = path.join(r.path, '.git', 'index.lock');
    try { if (fs.existsSync(lock)) fs.unlinkSync(lock); } catch (e) {}
  }
}

async function defaultBranch(cwd) {
  const forced = cfg('mainBranch', '');
  if (forced) return forced;
  if (defaultBranchCache.has(cwd)) return defaultBranchCache.get(cwd);
  let branch;
  const r = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (r.code === 0 && r.out) branch = r.out.replace(/^origin\//, '');
  else {
    const m = await git(cwd, ['rev-parse', '--verify', '--quiet', 'origin/main']);
    branch = (m.code === 0) ? 'main' : 'master';
  }
  defaultBranchCache.set(cwd, branch);
  return branch;
}

function findProject(name) { return getProjects().find(p => p.name === name); }

// Filtra los repos de un proyecto por los seleccionados en el panel (vacio/ausente = todos).
function filterRepos(proj, names) {
  return (Array.isArray(names) && names.length) ? proj.repos.filter(r => names.includes(r.name)) : proj.repos;
}

// ---------------------------------------------------------------------------
//  Sincronizacion con VSCode (extension <-> editor / terminal)
// ---------------------------------------------------------------------------
// Fuerza el refresco de la vista de git nativa (indicador de rama, SCM).
// Usamos la API de la extension Git (refresca cada repo por su cuenta) en vez del
// comando global `git.refresh`, que en workspaces con varios repos abre el
// molesto selector "Choose a repository". Fallback al comando si la API no esta.
let _gitApi = null;
function getGitApi() {
  if (_gitApi) return _gitApi;
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (ext && ext.isActive && ext.exports && ext.exports.getAPI) _gitApi = ext.exports.getAPI(1);
  } catch (e) {}
  return _gitApi;
}
function refreshVscodeGit() {
  const api = getGitApi();
  if (api && Array.isArray(api.repositories) && api.repositories.length) {
    let done = false;
    for (const r of api.repositories) {
      try { if (typeof r.status === 'function') { r.status(); done = true; } } catch (e) {}
    }
    if (done) return;   // refrescamos cada repo sin abrir ningun selector
  }
  try { vscode.commands.executeCommand('git.refresh'); } catch (e) {}
}

// Nombre del proyecto que corresponde a la carpeta/archivo activo en VSCode.
function activeProjectName() {
  const projects = getProjects();
  const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
  const active = vscode.window.activeTextEditor;
  const activePath = active && active.document.uri.scheme === 'file' ? active.document.uri.fsPath.toLowerCase() : '';
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath.toLowerCase());
  // 1) por el archivo activo
  if (activePath) {
    for (const p of projects) {
      if (inside(activePath, p.dir.toLowerCase())) return p.name;
      for (const r of p.repos) if (inside(activePath, r.path.toLowerCase())) return p.name;
    }
  }
  // 2) por la(s) carpeta(s) del workspace
  for (const p of projects) {
    const dl = p.dir.toLowerCase();
    for (const f of folders) if (inside(f, dl) || inside(dl, f)) return p.name;
    for (const r of p.repos) { const rl = r.path.toLowerCase(); for (const f of folders) if (inside(f, rl) || inside(rl, f)) return p.name; }
  }
  return null;
}

// Le dice al webview que seleccione el proyecto activo (NO abre carpeta: evita bucles).
function autoSelect() {
  const name = activeProjectName();
  if (name) post({ type: 'select', project: name });
}

// Refresco en vivo (con debounce) del estado del proyecto activo tras editar archivos.
let dirtyDebounce = null;
function scheduleDirtyRefresh() {
  if (!currentProject) return;
  if (dirtyDebounce) clearTimeout(dirtyDebounce);
  dirtyDebounce = setTimeout(() => { if (currentProject) sendStatus(currentProject); }, 400);
}
// Un archivo del proyecto activo cambio en VSCode -> reprograma el refresco del estado.
function onWorkspaceFileChange(uri) {
  if (!uri || uri.scheme !== 'file' || !currentProject) return;
  const proj = findProject(currentProject);
  if (!proj) return;
  const fp = uri.fsPath.toLowerCase();
  const inside = (c, p) => c === p || c.startsWith(p + path.sep);
  const hit = inside(fp, proj.dir.toLowerCase()) || proj.repos.some(r => inside(fp, r.path.toLowerCase()));
  if (hit) scheduleDirtyRefresh();
}

// El usuario eligio un proyecto en el dropdown: abre su carpeta como workspace en VSCode.
// Si ya esta abierta, solo refresca el estado (no recarga la ventana).
async function selectProject(name) {
  const proj = findProject(name);
  if (!proj) { await sendStatus(name); return; }
  const tl = proj.dir.toLowerCase();
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath.toLowerCase());
  const already = folders.some(f => f === tl || f.startsWith(tl + path.sep) || tl.startsWith(f + path.sep));
  if (already) { await sendStatus(name); return; }
  post({ type: 'log', level: 'dim', text: `Abriendo ${proj.name} en VSCode...` });
  suppressWatchUntil = Date.now() + 2500;
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(proj.dir), { forceNewWindow: false });
}

// Observa .git/HEAD de cada repo del proyecto: si cambias de rama desde VSCode o la
// terminal, la extension refresca su estado automaticamente.
function armHeadWatchers(proj) {
  disposeHeadWatchers();
  if (!proj) return;
  for (const repo of proj.repos) {
    const gitDir = path.join(repo.path, '.git');
    try {
      const w = fs.watch(gitDir, { persistent: false }, (event, filename) => {
        const fn = filename ? filename.toString() : '';
        // staging desde la terminal (git add/reset) toca .git/index -> refresca el estado "sin commitear"
        if (fn === 'index') { if (Date.now() < suppressWatchUntil) return; scheduleDirtyRefresh(); return; }
        if (fn !== 'HEAD' && fn !== 'ORIG_HEAD') return;
        if (Date.now() < suppressWatchUntil) return;   // ignora nuestros propios checkouts
        if (headDebounce) clearTimeout(headDebounce);
        headDebounce = setTimeout(() => { if (currentProject) { refreshVscodeGit(); sendStatus(currentProject); } }, 300);
      });
      headWatchers.push(w);
    } catch (e) { /* .git puede ser archivo (worktree) o no existir: se ignora */ }
  }
}

function disposeHeadWatchers() {
  for (const w of headWatchers) { try { w.close(); } catch (e) {} }
  headWatchers = [];
}

// ---------------------------------------------------------------------------
//  STATUS: rama actual + ahead/behind + cambios por repo
// ---------------------------------------------------------------------------
// Lee TODO el estado de un repo en 2 llamadas git (en vez de ~6):
//  - `git status --porcelain=v1 --branch`: rama, upstream, ahead/behind y archivos.
//  - `git for-each-ref refs/heads`: ramas locales ordenadas por actividad reciente.
async function readRepo(repo) {
  const st = await git(repo.path, ['status', '--porcelain', '--branch']);
  const lines = (st.out || '').split('\n');
  let branch = '?', hasUp = false, ahead = 0, behind = 0;
  const header = lines[0] || '';
  const hm = header.match(/^## (.+)$/);
  if (hm) {
    let h = hm[1];
    if (/^HEAD \(no branch\)/.test(h) || /^\(detached/.test(h)) {
      branch = '(detached)';
    } else {
      const ab = h.match(/\[(.+)\]\s*$/);
      if (ab) {
        const a = ab[1].match(/ahead (\d+)/); const b = ab[1].match(/behind (\d+)/);
        ahead = a ? parseInt(a[1], 10) : 0;
        behind = b ? parseInt(b[1], 10) : 0;
        h = h.replace(/\s*\[.+\]\s*$/, '');
      }
      const parts = h.split('...');
      branch = parts[0].trim();
      hasUp = parts.length > 1;
    }
  }
  const fileLines = lines.slice(1).filter(Boolean);
  const files = fileLines.slice(0, 60).map(l => ({ code: l.slice(0, 2), path: l.slice(3) }));

  // ramas LOCALES + REMOTAS (una sola llamada, ordenadas por actividad reciente)
  const br = await git(repo.path, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  const branches = [];
  const seenB = new Set();
  for (const raw of (br.out || '').split('\n').map(s => s.trim()).filter(Boolean)) {
    let name;
    if (raw.startsWith('refs/heads/')) name = raw.slice(11);
    else if (raw.startsWith('refs/remotes/')) {
      const rest = raw.slice(13);           // ej: origin/feature/x  |  origin/HEAD
      if (/\/HEAD$/.test(rest)) continue;    // ignora el puntero HEAD del remoto
      name = rest.replace(/^[^/]+\//, '');   // quita el nombre del remoto (origin/)
    } else continue;
    if (name && !seenB.has(name)) { seenB.add(name); branches.push(name); }
  }

  const rem = await git(repo.path, ['remote', 'get-url', 'origin']);
  const hasRemote = rem.code === 0 && !!rem.out;
  // la rama actual existe en el remoto? (aunque no tenga upstream configurado)
  const remoteHasBranch = hasRemote && branch && branch !== '(detached)' &&
    (await git(repo.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).code === 0;

  // --- Relacion con la rama principal (el concepto clave de los apuntes) ---
  // Una rama es solo una etiqueta que apunta a un commit. "ahead N" compara la
  // rama local con SU pareja remota (origin/rama), no mide trabajo tuyo. Para
  // saber si esos commits son de verdad tuyos, los comparamos contra main.
  const main = await defaultBranch(repo.path);
  const onMain = branch === main;
  let mainExists = false;     // origin/main existe localmente (foto del ultimo fetch)?
  let uniqueVsMain = 0;       // commits en HEAD que NO estan en origin/main (= trabajo propio real)
  let mergedInMain = false;   // HEAD ya esta contenido en origin/main (rama ya fusionada)
  let phantomAhead = false;   // ahead>0 pero esos commits YA viven en main -> hueco fantasma
  if (hasRemote && branch && branch !== '(detached)') {
    mainExists = (await git(repo.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${main}`])).code === 0;
    if (mainExists && !onMain) {
      uniqueVsMain = parseInt((await git(repo.path, ['rev-list', '--count', `origin/${main}..HEAD`])).out || '0', 10) || 0;
      mergedInMain = (await git(repo.path, ['merge-base', '--is-ancestor', 'HEAD', `origin/${main}`])).code === 0;
      // ahead sobre origin/rama pero sin nada propio frente a main = etiqueta vieja apuntando atras
      phantomAhead = ahead > 0 && uniqueVsMain === 0;
    }
  }

  return { name: repo.name, branch, ahead, behind, dirty: fileLines.length, hasUp, hasRemote, remoteHasBranch,
    remoteUrl: rem.out || '', files, branches, main, onMain, mainExists, uniqueVsMain, mergedInMain, phantomAhead };
}

async function sendStatus(projectName) {
  const proj = findProject(projectName);
  if (!proj) return;
  if (currentProject !== projectName) { currentProject = projectName; armHeadWatchers(proj); }
  const results = await Promise.all(proj.repos.map(readRepo));
  const repos = results.map(r => ({ name: r.name, branch: r.branch, ahead: r.ahead, behind: r.behind, dirty: r.dirty,
    hasUp: r.hasUp, hasRemote: r.hasRemote, files: r.files, onMain: r.onMain, mergedInMain: r.mergedInMain, phantomAhead: r.phantomAhead }));
  // union de ramas conservando el orden por actividad reciente
  const seen = new Set(); const branches = [];
  for (const r of results) for (const b of r.branches) { if (!seen.has(b)) { seen.add(b); branches.push(b); } }
  const currents = new Set(results.map(r => r.branch));
  const current = currents.size === 1 ? Array.from(currents)[0] : '';
  // rama principal comun (para el boton "Ir a main"); si difieren entre repos, la mas frecuente
  const mainCount = {};
  for (const r of results) if (r.main) mainCount[r.main] = (mainCount[r.main] || 0) + 1;
  const mainBranch = Object.keys(mainCount).sort((a, b) => mainCount[b] - mainCount[a])[0] || '';
  post({ type: 'status', project: projectName, repos, branches, current, mainBranch, hint: assistantHint(proj.name, results) });
}

// Escapa texto (nombres de rama/repo, que git permite con < > & ") antes de meterlo en HTML.
function htmlEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Mensaje proactivo de la mascota-asistente segun el estado agregado.
// El orden importa: los casos "trampa" (donde Push seria un error) van PRIMERO.
function assistantHint(projName, results) {
  const noRemote = results.filter(r => !r.hasRemote);
  const dirty = results.reduce((s, r) => s + r.dirty, 0);
  const behind = results.reduce((s, r) => s + r.behind, 0);
  const noUp = results.filter(r => r.hasRemote && !r.hasUp);

  if (noRemote.length) {
    const n = noRemote.map(r => htmlEsc(r.name)).join(', ');
    return `&#9888; ${n} no est&aacute; conectado a un remoto. Con&eacute;ctalo: <span class="mono">git remote add origin &lt;url&gt;</span> y luego Push.`;
  }
  if (dirty > 0) return `Tienes <b>${dirty} cambio(s) sin commitear</b> &#9749; &mdash; escribe un mensaje (o dale &#10024;) y Commit.`;

  // CASO TRAMPA (apuntes de flujo): estas parado en una rama con "ahead N" pero esos
  // commits YA viven en main en el servidor. Es una etiqueta vieja apuntando atras,
  // no trabajo tuyo pendiente. Push aqui reviviria una rama muerta -> mejor ir a main.
  const phantom = results.filter(r => r.phantomAhead);
  if (phantom.length) {
    const r = phantom[0]; const rb = htmlEsc(r.branch), rm = htmlEsc(r.main);
    return `Est&aacute;s en <b>${rb}</b> con <b>${r.ahead} &laquo;commit(s) sin pushear&raquo;</b>, pero esos commits <b>ya est&aacute;n en el servidor dentro de <span class="mono">${rm}</span></b>. &laquo;ahead&raquo; compara punteros, no mide tu trabajo: es una etiqueta vieja apuntando atr&aacute;s. <b>No hagas Push.</b> Dale <b>&#8962; Ir a ${rm}</b>.`;
  }

  // ahead REAL: hay commits tuyos que main todavia no tiene -> Push si tiene sentido.
  const realAhead = results.reduce((s, r) => s + ((r.phantomAhead) ? 0 : r.ahead), 0);
  if (realAhead > 0) return `Tienes <b>${realAhead} commit(s) sin pushear</b> &#8593; &mdash; dale <b>Push</b> para subirlos.`;

  // rama sin upstream que YA existe en el remoto: no es "publicar", es "enlazar"
  const linkNeeded = noUp.filter(r => r.remoteHasBranch);
  if (linkNeeded.length) {
    const r = linkNeeded[0];
    return `Tu rama <b>ya existe en GitHub</b> pero no est&aacute; enlazada (por eso VS Code dice &laquo;Publish Branch&raquo;). Enl&aacute;zala: <span class="mono">git branch --set-upstream-to=origin/${htmlEsc(r.branch)}</span> y luego <b>Pull</b>. No uses Publish.`;
  }
  if (noUp.length) return `Tu rama es <b>nueva</b> (no est&aacute; en el remoto) &#8593; &mdash; dale <b>Push</b> y la creo en GitHub.`;
  if (behind > 0) return `Hay <b>${behind} commit(s) nuevo(s)</b> en el remoto &#8595; &mdash; dale <b>Pull</b>.`;

  // rama limpia y ya fusionada en main: su trabajo ya vive en main. Volver a main es higiene.
  const merged = results.filter(r => r.mergedInMain && !r.onMain);
  if (merged.length) {
    const r = merged[0]; const rb = htmlEsc(r.branch), rm = htmlEsc(r.main);
    return `<b>${rb}</b> ya est&aacute; <b>fusionada en <span class="mono">${rm}</span></b>: su trabajo ya vive ah&iacute;. Puedes volver con <b>&#8962; Ir a ${rm}</b> sin perder nada.`;
  }
  return `Todo al d&iacute;a &#10024; &iquest;un cafecito? &#9749;`;
}

// ---------------------------------------------------------------------------
//  CHECK / PULL main
// ---------------------------------------------------------------------------
async function runMain(kind, projectName, repoNames) {
  const proj = findProject(projectName);
  if (!proj) { post({ type: 'log', level: 'err', text: 'Proyecto no encontrado' }); post({ type: 'done' }); return; }
  const repos = filterRepos(proj, repoNames);
  post({ type: 'busy' });
  post({ type: 'log', level: 'hdr', text: `== ${kind === 'check' ? 'CHECK' : 'PULL'} :: ${proj.name} ==` });

  let pending = 0, conflicts = 0;
  for (const repo of repos) {
    if (opCancelled) break;
    const branch = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || '?';
    const tag = `${repo.name} (${branch})`;
    const dirty = await git(repo.path, ['status', '--porcelain']);
    if (dirty.out) { post({ type: 'log', level: 'warn', text: `${tag}: cambios sin commitear -> sin acciones` }); continue; }
    const main = await defaultBranch(repo.path);

    if (kind === 'check') {
      post({ type: 'log', level: 'dim', text: `${tag}: fetch --all --prune...` });
      const f = await git(repo.path, ['fetch', '--all', '--prune', '--quiet']);
      if (f.code !== 0) { post({ type: 'log', level: 'err', text: `${tag}: no se pudo conectar al remoto` }); continue; }
      // compara TU rama actual contra su remoto:
      //  1) upstream si existe; 2) si no, origin/<misma-rama> si existe; 3) si no, origin/main
      const up = await git(repo.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      let ref, refName;
      if (up.code === 0) { ref = '@{u}'; refName = up.out || 'remoto'; }
      else if ((await git(repo.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).code === 0) {
        ref = `origin/${branch}`; refName = `origin/${branch} (sin upstream)`;
      } else { ref = `origin/${main}`; refName = `origin/${main}`; }
      const behind = parseInt((await git(repo.path, ['rev-list', '--count', `HEAD..${ref}`])).out || '0', 10) || 0;
      if (behind <= 0) post({ type: 'log', level: 'ok', text: `${tag}: al dia con ${refName}` });
      else {
        pending += behind;
        post({ type: 'log', level: 'warn', text: `${tag}: ${behind} commit(s) nuevo(s) en ${refName}` });
        (await git(repo.path, ['log', `HEAD..${ref}`, '--oneline', '-10'])).out.split('\n').filter(Boolean)
          .forEach(l => post({ type: 'log', level: 'dim', text: '   ' + l }));
      }
      // aviso extra si main tambien avanzo y no estas en main
      if (branch !== main) {
        const bm = parseInt((await git(repo.path, ['rev-list', '--count', `HEAD..origin/${main}`])).out || '0', 10) || 0;
        if (bm > 0) post({ type: 'log', level: 'dim', text: `   (${main} va ${bm} commit(s) adelante)` });
        // hueco fantasma: ahead sobre origin/rama pero sin nada propio frente a main
        const originHasBranch = (await git(repo.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).code === 0;
        const mainExists = (await git(repo.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${main}`])).code === 0;
        if (originHasBranch && mainExists) {
          const aheadOwn = parseInt((await git(repo.path, ['rev-list', '--count', `origin/${branch}..HEAD`])).out || '0', 10) || 0;
          const uniqueVsMain = parseInt((await git(repo.path, ['rev-list', '--count', `origin/${main}..HEAD`])).out || '0', 10) || 0;
          if (aheadOwn > 0 && uniqueVsMain === 0) {
            post({ type: 'log', level: 'warn', text: `   ${tag}: "ahead ${aheadOwn}" es un hueco fantasma -> esos commits ya estan en origin/${main}` });
            post({ type: 'log', level: 'dim', text: `   No pushees esta rama; cambia a ${main} (Ir a ${main}).` });
          }
        }
      }
    } else {
      // PULL de TU rama actual desde el remoto (no de main)
      const up = await git(repo.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      let hasUp = up.code === 0;
      const originHas = (await git(repo.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).code === 0;
      if (!hasUp && !originHas) {
        post({ type: 'log', level: 'warn', text: `${tag}: tu rama no esta en el remoto -> nada que traer (usa Push para subirla)` });
        continue;
      }
      // enlaza la rama si existe en el remoto pero no tiene upstream (arregla "Publish Branch")
      if (!hasUp && originHas) {
        const su = await git(repo.path, ['branch', `--set-upstream-to=origin/${branch}`]);
        if (su.code === 0) { hasUp = true; post({ type: 'log', level: 'dim', text: `${tag}: enlazada a origin/${branch}` }); }
      }
      const before = (await git(repo.path, ['rev-parse', 'HEAD'])).out;
      post({ type: 'log', level: 'dim', text: `${tag}: pull de origin/${branch}...` });
      const p = hasUp
        ? await git(repo.path, ['pull', '--no-rebase'])
        : await git(repo.path, ['pull', 'origin', branch, '--no-rebase']);
      if (p.code !== 0) {
        await git(repo.path, ['merge', '--abort']);
        conflicts++;
        post({ type: 'log', level: 'err', text: `${tag}: no se pudo integrar (conflicto o error)` });
        (p.err || p.out || '').split('\n').filter(Boolean).slice(0, 3).forEach(e => post({ type: 'log', level: 'dim', text: '   ' + e }));
        continue;
      }
      const commits = (await git(repo.path, ['log', `${before}..HEAD`, '--oneline'])).out.split('\n').filter(Boolean);
      if (commits.length === 0) post({ type: 'log', level: 'ok', text: `${tag}: ya estaba al dia` });
      else {
        post({ type: 'log', level: 'ok', text: `${tag}: integrados ${commits.length} commit(s)` });
        commits.slice(0, 10).forEach(l => post({ type: 'log', level: 'dim', text: '   ' + l }));
      }
    }
  }
  if (opCancelled) cleanupLocks(repos);
  post({ type: 'log', level: 'hdr', text: opCancelled ? '>> Operacion cancelada'
    : kind === 'check'
    ? (pending > 0 ? `>> ${pending} commit(s) pendientes de pull` : '>> Todo al dia')
    : (conflicts > 0 ? `>> ${conflicts} repo(s) con conflicto` : '>> Pull completo') });
  post({ type: 'done' });
  await sendStatus(projectName);
}

// ---------------------------------------------------------------------------
//  COMMIT (add -A + commit) en cada repo con cambios
// ---------------------------------------------------------------------------
// Comprueba que git tenga nombre+email para commitear; si falta, ofrece configurarlo (global).
async function ensureGitIdentity(cwd) {
  const name = (await git(cwd, ['config', 'user.name'])).out;
  const email = (await git(cwd, ['config', 'user.email'])).out;
  if (name && email) return true;
  const pick = await vscode.window.showWarningMessage(
    'Git no tiene configurado tu nombre/email para commitear.', 'Configurar', 'Cancelar');
  if (pick !== 'Configurar') return false;
  const n = await vscode.window.showInputBox({ prompt: 'Tu nombre para git (user.name)', value: name || '', ignoreFocusOut: true });
  if (!n || !n.trim()) return false;
  const e = await vscode.window.showInputBox({ prompt: 'Tu email para git (user.email)', value: email || '', ignoreFocusOut: true });
  if (!e || !e.trim()) return false;
  await git(cwd, ['config', '--global', 'user.name', n.trim()]);
  await git(cwd, ['config', '--global', 'user.email', e.trim()]);
  return true;
}

async function commitAction(projectName, message, repoNames) {
  const proj = findProject(projectName);
  if (!proj) { post({ type: 'log', level: 'err', text: 'Proyecto no encontrado' }); post({ type: 'done' }); return; }
  if (!message || !message.trim()) { post({ type: 'log', level: 'err', text: 'Escribe un mensaje de commit' }); post({ type: 'done' }); return; }
  const repos = filterRepos(proj, repoNames);
  post({ type: 'busy' });
  post({ type: 'log', level: 'hdr', text: `== COMMIT :: ${proj.name} ==` });

  // git no puede commitear sin user.name / user.email configurados: detectalo antes y ofrece arreglarlo
  if (repos.length && !(await ensureGitIdentity(repos[0].path))) {
    post({ type: 'log', level: 'err', text: 'Commit cancelado: falta configurar user.name / user.email en git.' });
    post({ type: 'done' }); return;
  }

  let done = 0;
  for (const repo of repos) {
    if (opCancelled) break;
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
  if (opCancelled) cleanupLocks(repos);
  post({ type: 'log', level: 'hdr', text: opCancelled ? '>> Operacion cancelada' : done > 0 ? `>> ${done} repo(s) commiteados. Ahora puedes Push.` : '>> No habia cambios para commitear' });
  post({ type: 'done' });
  await sendStatus(projectName);
}

// ---------------------------------------------------------------------------
//  PUSH (crea upstream si falta)
// ---------------------------------------------------------------------------
async function pushAction(projectName, repoNames) {
  const proj = findProject(projectName);
  if (!proj) { post({ type: 'log', level: 'err', text: 'Proyecto no encontrado' }); post({ type: 'done' }); return; }
  const repos = filterRepos(proj, repoNames);
  post({ type: 'busy' });
  post({ type: 'log', level: 'hdr', text: `== PUSH :: ${proj.name} ==` });

  let failed = 0;
  for (const repo of repos) {
    if (opCancelled) break;
    const branch = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || '?';
    const tag = `${repo.name} (${branch})`;

    // 1) hay remoto 'origin'?
    const rem = await git(repo.path, ['remote', 'get-url', 'origin']);
    if (rem.code !== 0 || !rem.out) {
      failed++;
      post({ type: 'log', level: 'err', text: `${tag}: NO hay remoto 'origin' configurado.` });
      post({ type: 'log', level: 'dim', text: `   Conectalo: git remote add origin https://github.com/usuario/repo.git` });
      continue;
    }

    const up = await git(repo.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    let p;
    if (up.code !== 0) {
      post({ type: 'log', level: 'dim', text: `${tag}: rama nueva, subiendo a origin/${branch}...` });
      p = await git(repo.path, ['push', '-u', 'origin', branch]);
    } else {
      post({ type: 'log', level: 'dim', text: `${tag}: push...` });
      p = await git(repo.path, ['push']);
    }
    if (p.code !== 0) {
      failed++;
      const err = (p.err || p.out || '').split('\n').filter(Boolean).slice(0, 3);
      post({ type: 'log', level: 'err', text: `${tag}: fallo push` });
      err.forEach(e => post({ type: 'log', level: 'dim', text: '   ' + e }));
      // pistas comunes
      const joined = (p.err || p.out || '').toLowerCase();
      if (joined.includes('authentication') || joined.includes('403') || joined.includes('permission') || joined.includes('could not read')) {
        post({ type: 'log', level: 'warn', text: '   -> parece problema de credenciales: prueba "gh auth login" o revisa el Git Credential Manager.' });
      } else if (joined.includes('rejected') || joined.includes('non-fast-forward') || joined.includes('behind')) {
        post({ type: 'log', level: 'warn', text: '   -> el remoto va adelante: haz Pull primero y reintenta Push.' });
      }
      continue;
    }
    post({ type: 'log', level: 'ok', text: `${tag}: push OK` });
  }
  post({ type: 'log', level: 'hdr', text: opCancelled ? '>> Operacion cancelada' : failed > 0 ? `>> Push con ${failed} error(es)` : '>> Push terminado' });
  post({ type: 'done' });
  await sendStatus(projectName);
}

// ---------------------------------------------------------------------------
//  SUGERIR mensaje de commit (analiza el diff real; genera asunto + cuerpo)
// ---------------------------------------------------------------------------
function baseName(p) { return p.split('/').pop().replace(/"/g, ''); }
function topDir(p) { const parts = p.split('/'); return parts.length > 1 ? parts[0] : ''; }
function briefList(names, max) {
  const u = Array.from(new Set(names)); max = max || 2;
  if (u.length === 1) return u[0];
  if (u.length <= max) return u.slice(0, -1).join(', ') + ' y ' + u[u.length - 1];
  return `${u.slice(0, max).join(', ')} y ${u.length - max} mas`;
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// clasificadores de archivo
const isTest = p => /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.[a-z]+$/i.test(p);
const isDoc = p => /\.(md|mdx|rst|txt)$/i.test(p) || /(^|\/)docs?\//i.test(p);
const isStyle = p => /\.(css|scss|sass|less|styl)$/i.test(p);
const isConfig = p => /(package(-lock)?\.json|yarn\.lock|pnpm-lock\.ya?ml|\.ya?ml|\.toml|dockerfile|\.dockerignore|\.gitignore|\.env|tsconfig|\.eslintrc|\.prettier|vite\.config|webpack|babel\.config)/i.test(p);

async function suggestMessage(projectName, repoNames) {
  const proj = findProject(projectName);
  if (!proj) { post({ type: 'done' }); return; }
  const repos = filterRepos(proj, repoNames);
  post({ type: 'busy' });
  post({ type: 'log', level: 'dim', text: 'Analizando diff…' });

  const changes = [];        // {code,path,add,del,kind,repo}
  let convStyle = false;     // el repo usa conventional commits?
  let fixSignal = false, featSignal = false;
  let diffText = '';         // muestra del diff acumulada para el modelo de IA
  const DIFF_CAP = 12000;
  const multiRepo = repos.length > 1;

  for (const repo of repos) {
    const st = await git(repo.path, ['status', '--porcelain']);
    const rows = (st.out || '').split('\n').filter(Boolean);
    if (!rows.length) continue;

    // lineas +/- de lo ya trackeado (working tree vs HEAD)
    const ns = await git(repo.path, ['diff', 'HEAD', '--numstat']);
    const nmap = {};
    (ns.out || '').split('\n').filter(Boolean).forEach(l => {
      const t = l.split('\t'); const a = parseInt(t[0], 10) || 0; const d = parseInt(t[1], 10) || 0;
      nmap[(t[2] || '').replace(/^"|"$/g, '')] = { add: a, del: d };
    });

    // estilo del historial reciente
    const lg = await git(repo.path, ['log', '-10', '--format=%s']);
    if (/^(feat|fix|docs|chore|refactor|style|test|build|perf)(\(|:|!)/mi.test(lg.out || '')) convStyle = true;

    // muestra del contenido para detectar fix/feat
    const diff = await git(repo.path, ['diff', 'HEAD', '--unified=0']);
    const dsample = (diff.out || '').slice(0, 20000);
    if (diffText.length < DIFF_CAP) {
      const hdr = multiRepo ? `# repo: ${repo.name}\n` : '';
      diffText += hdr + (diff.out || '').slice(0, DIFF_CAP - diffText.length) + '\n';
    }
    const addedLines = dsample.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const addedText = addedLines.join('\n');
    if (/\b(fix|bug|error|catch|throw|corrige|arregla|hotfix|patch|npe|null|undefined check)\b/i.test(addedText)) fixSignal = true;
    if (/\b(export (default |const |function |class )|def |func |public (class|function)|add(s|ed)? )/i.test(addedText)) featSignal = true;

    for (const row of rows) {
      const code = row.slice(0, 2); let p = row.slice(3).replace(/^"|"$/g, '');
      const c = code.replace(/\s/g, '');
      let kind = 'mod';
      if (code.includes('?') || c.includes('A')) kind = 'add';
      else if (c.includes('D')) kind = 'del';
      else if (c.includes('R')) { kind = 'ren'; p = p.split(' -> ').pop().replace(/^"|"$/g, ''); }
      let add = 0, del = 0;
      if (code.includes('?')) {
        try { const full = path.join(repo.path, p); const s = fs.statSync(full); if (s.isFile() && s.size < 200000) add = fs.readFileSync(full, 'utf8').split('\n').length; } catch (e) {}
      } else if (nmap[p]) { add = nmap[p].add; del = nmap[p].del; }
      changes.push({ code, path: p, add, del, kind, repo: repo.name });
    }
  }

  if (!changes.length) {
    post({ type: 'log', level: 'warn', text: 'No hay cambios para sugerir un mensaje' });
    post({ type: 'done' });
    return;
  }

  const added = changes.filter(c => c.kind === 'add');
  const modified = changes.filter(c => c.kind === 'mod');
  const deleted = changes.filter(c => c.kind === 'del');
  const renamed = changes.filter(c => c.kind === 'ren');
  const paths = changes.map(c => c.path);
  const totalAdd = changes.reduce((s, c) => s + c.add, 0);
  const totalDel = changes.reduce((s, c) => s + c.del, 0);

  // --- tipo ---
  const allDocs = paths.every(isDoc);
  const allStyle = paths.every(isStyle);
  const allTest = paths.every(isTest);
  const allConfig = paths.every(isConfig);
  let type;
  if (allDocs) type = 'docs';
  else if (allTest) type = 'test';
  else if (allStyle) type = 'style';
  else if (allConfig) type = 'chore';
  else if (fixSignal && !added.length) type = 'fix';
  else if (added.length && (featSignal || !modified.length)) type = 'feat';
  else if (deleted.length && !added.length && !modified.length) type = 'chore';
  else if (renamed.length && !added.length && !modified.length) type = 'refactor';
  else if (fixSignal) type = 'fix';
  else type = 'refactor';

  // --- scope: carpeta de primer nivel mas comun (ignora archivos raiz) ---
  const dirCount = {};
  for (const p of paths) { const d = topDir(p); if (d && d !== 'src') dirCount[d] = (dirCount[d] || 0) + 1; }
  let scope = Object.keys(dirCount).sort((a, b) => dirCount[b] - dirCount[a])[0] || '';
  if (multiRepo && new Set(changes.map(c => c.repo)).size > 1) scope = ''; // cambios en varios repos -> sin scope

  // --- asunto ---
  const parts = [];
  if (added.length) parts.push(`agrega ${briefList(added.map(c => baseName(c.path)))}`);
  if (modified.length) parts.push(`actualiza ${briefList(modified.map(c => baseName(c.path)))}`);
  if (renamed.length) parts.push(`renombra ${briefList(renamed.map(c => baseName(c.path)))}`);
  if (deleted.length) parts.push(`elimina ${briefList(deleted.map(c => baseName(c.path)))}`);
  let subject = parts.join(', ');
  const head = convStyle ? `${type}${scope ? `(${scope})` : ''}: ${subject}` : cap(subject);
  let subjectLine = head.length > 72 ? head.slice(0, 69).trimEnd() + '...' : head;

  // --- cuerpo con vinetas por archivo (ordenado por tamano de cambio) ---
  const verbOf = { add: 'nuevo', del: 'eliminado', ren: 'renombrado', mod: '' };
  const body = changes
    .slice()
    .sort((a, b) => (b.add + b.del) - (a.add + a.del))
    .slice(0, 15)
    .map(c => {
      const stat = c.kind === 'add' ? `nuevo, +${c.add}` : c.kind === 'del' ? 'eliminado' : c.kind === 'ren' ? 'renombrado' : `+${c.add} -${c.del}`;
      const label = multiRepo ? `${c.repo}/${c.path}` : c.path;
      return `- ${label} (${stat})`;
    });
  if (changes.length > 15) body.push(`- …y ${changes.length - 15} archivo(s) mas`);

  let message = `${subjectLine}\n\n${body.join('\n')}`;

  // --- intento con IA (VSCode Language Model API); si no hay modelo, queda la heuristica ---
  let usedAi = false, aiModel = '';
  if (!opCancelled) {
    const fileSummary = changes.slice(0, 40).map(c => {
      const k = c.kind === 'add' ? 'nuevo' : c.kind === 'del' ? 'eliminado' : c.kind === 'ren' ? 'renombrado' : 'modificado';
      return `${k}: ${multiRepo ? c.repo + '/' : ''}${c.path} (+${c.add} -${c.del})`;
    }).join('\n');
    post({ type: 'log', level: 'dim', text: 'Consultando modelo de IA (si hay)…' });
    const ai = await aiCommitMessage(fileSummary, diffText, { convStyle });
    if (ai && ai.text) { message = ai.text; usedAi = true; aiModel = ai.model; }
  }

  post({ type: 'log', level: 'ok', text: usedAi
    ? `Sugerencia con IA (${aiModel}): ${changes.length} archivo(s), +${totalAdd} -${totalDel}`
    : `Sugerencia lista: ${changes.length} archivo(s), +${totalAdd} -${totalDel}` });
  post({ type: 'suggest', message });
  post({ type: 'done' });
}

// Genera un mensaje de commit con el modelo de IA del editor (VSCode Language Model API).
// Requiere que el usuario tenga un proveedor de chat instalado (Copilot, Claude, etc.). Si no
// hay modelo o algo falla, devuelve null y el llamador usa la sugerencia heuristica (offline).
async function aiCommitMessage(fileSummary, diffText, opts) {
  try {
    if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') return null;
    const models = await vscode.lm.selectChatModels();
    if (!models || !models.length) return null;
    const model = models[0];
    const style = opts.convStyle
      ? 'Usa Conventional Commits: "tipo(scope): asunto" con tipos feat, fix, docs, style, refactor, perf, test o chore.'
      : 'Escribe el asunto en imperativo, sin prefijo de tipo.';
    const prompt = [
      'Eres un asistente que redacta mensajes de commit claros en espanol.',
      'A partir del resumen de archivos y el diff, redacta UN mensaje de commit:',
      '- Primera linea (asunto) de 72 caracteres o menos que describa QUE hace el cambio y por que, no solo que archivos toca.',
      '- Una linea en blanco.',
      '- Cuerpo con vinetas "- " (maximo 8) explicando los cambios relevantes.',
      style,
      'Responde SOLO con el mensaje de commit, sin comillas, sin explicaciones y sin bloques de codigo.',
      '',
      'ARCHIVOS:',
      fileSummary || '(sin resumen)',
      '',
      'DIFF:',
      diffText || '(sin diff)'
    ].join('\n');
    const cts = new vscode.CancellationTokenSource();
    activeLmCancel = cts;
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const resp = await model.sendRequest(messages, { justification: 'Brew genera un mensaje de commit a partir de tu diff.' }, cts.token);
    let text = '';
    for await (const part of resp.text) { if (opCancelled) break; text += part; }
    activeLmCancel = null;
    text = (text || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
    return text ? { text, model: model.name || model.family || 'IA' } : null;
  } catch (e) {
    activeLmCancel = null;
    return null;
  }
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
    const hasLocal = (await git(repo.path, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])).code === 0;
    const hasRemoteBranch = (await git(repo.path, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + branch])).code === 0;
    if (!hasLocal && !hasRemoteBranch) { post({ type: 'log', level: 'dim', text: `${repo.name}: no tiene la rama ${branch}` }); continue; }
    if (!hasLocal) post({ type: 'log', level: 'dim', text: `${repo.name}: creando local desde origin/${branch}...` });
    const co = await git(repo.path, ['checkout', branch]); // git crea el tracking local si solo existe en el remoto
    if (co.code !== 0) { post({ type: 'log', level: 'err', text: `${repo.name}: no se pudo cambiar - ${(co.err || co.out).split('\n')[0]}` }); continue; }
    post({ type: 'log', level: 'ok', text: `${repo.name}: ahora en ${branch}` });
  }
  post({ type: 'log', level: 'hdr', text: '>> Listo' });
  refreshVscodeGit();
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
  refreshVscodeGit();
  post({ type: 'done' });
  await sendStatus(projectName);
}

// ---------------------------------------------------------------------------
//  VER DIFF de un archivo (clic en la lista de cambios) con el diff nativo
// ---------------------------------------------------------------------------
async function openDiff(projectName, repoName, relPath, code) {
  const proj = findProject(projectName);
  if (!proj || !relPath) return;
  const repo = proj.repos.find(r => r.name === repoName) || proj.repos[0];
  if (!repo) return;
  let rel = relPath.replace(/^"|"$/g, '');
  if (rel.includes(' -> ')) rel = rel.split(' -> ').pop().replace(/^"|"$/g, '');   // renombrado: usa el nombre nuevo
  const full = vscode.Uri.file(path.join(repo.path, rel));
  const c = (code || '').trim();
  // nuevos/sin trackear/renombrados: no hay version previa que comparar -> abre el archivo
  if (c.includes('?') || c.includes('A') || c.includes('R')) {
    try { await vscode.window.showTextDocument(full, { preview: true }); } catch (e) {}
    return;
  }
  const left = brewUri(repo.path, 'HEAD', rel);
  if (c.includes('D')) {   // eliminado: HEAD vs vacio
    const right = brewUri(repo.path, '__EMPTY__', rel);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${rel} (HEAD ↔ eliminado)`, { preview: true });
    return;
  }
  await vscode.commands.executeCommand('vscode.diff', left, full, `${rel} (HEAD ↔ local)`, { preview: true });
}

// ---------------------------------------------------------------------------
//  HTML del webview  (cozy vintage cafe)
// ---------------------------------------------------------------------------
function getHtml() {
  let fontCss = '';
  try { fontCss = fs.readFileSync(path.join(__dirname, 'media', 'fonts.css'), 'utf8'); } catch (e) {}
  try { fontCss += '\n' + fs.readFileSync(path.join(__dirname, 'media', 'mascot.css'), 'utf8'); } catch (e) {}
  // fondo actual (imagen por defecto o personalizada) + intensidad, inyectados como variables
  try { fontCss += '\n:root{--bgimg:url("' + currentBgUri() + '");--veil:' + veilFor(bgOpacity()) + ';}'; } catch (e) {}
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  ${fontCss}
  :root {
    --bg1:#2f2015; --bg2:#20160d;
    --surfA:#332417; --surfB:#2c1e13; --surfC:#261a10;
    --bd1:#46331f; --bd2:#4f3a24; --bd3:#443020; --bd4:#3d2c1c;
    --amber:#e0912f; --green:#a6cf8f; --terra:#cf6b42;
    --txt:#f0e2cc; --txt2:#d8c4a4; --mut:#8f7657; --lab:#b98a52; --acc:#c9a877;
    --ok:#8fbf7a;
    --sans:"Space Grotesk",system-ui,sans-serif;
    --mono:"IBM Plex Mono",ui-monospace,monospace;
    --brand:var(--sans);
    /* interletraje unico para todas las micro-etiquetas en mayusculas */
    --track:.14em;
    /* velo del fondo: mayor = imagen menos visible (lo ajusta gitArcade.backgroundOpacity) */
    --veil:.86;
    /* lenguaje de degradado unificado para los botones (ambar/cafe de marca) */
    --grad:linear-gradient(150deg,#e6982f,#c8781f);
    --grad-soft:linear-gradient(160deg,var(--surfA),var(--surfB));
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body {
    margin:0; padding:14px; color:var(--txt); font-family:var(--sans); font-size:13px; letter-spacing:.01em; overflow-x:hidden;
    background:radial-gradient(120% 80% at 50% -5%, #43301c 0%, rgba(67,48,28,0) 55%), var(--bg2);
  }
  /* foto de fondo (por defecto o personalizada) con velo calido; --veil controla su visibilidad */
  body::before {
    content:""; position:fixed; inset:0; z-index:-1; pointer-events:none;
    background:
      linear-gradient(rgba(24,16,10,var(--veil,.86)), rgba(18,12,7,var(--veil,.86))),
      var(--bgimg) center/cover no-repeat;
    filter:saturate(.9);
    transition:background .18s ease;
  }

  .panel {
    position:relative; border-radius:18px; padding:18px; display:flex; flex-direction:column; gap:13px;
    background:linear-gradient(160deg, rgba(47,32,21,.90), rgba(32,22,13,.93)); backdrop-filter:blur(3px); border:1px solid var(--bd1);
    box-shadow:0 0 0 1px var(--bd1), 0 12px 34px -10px rgba(0,0,0,.75), 0 0 24px -4px rgba(224,145,47,.5), 0 0 64px -14px rgba(224,145,47,.35);
  }

  .header { display:flex; align-items:center; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:10px; }
  .logo { width:34px; height:34px; flex:none; filter:drop-shadow(0 0 6px rgba(224,145,47,.4)); }
  .wordmark { font-family:var(--brand); font-weight:700; font-size:21px; letter-spacing:.015em; line-height:1; color:#f7ecd4;
    text-shadow:0 0 8px rgba(224,145,47,.6),0 0 18px rgba(224,145,47,.3); animation:flick 4s infinite; }
  @keyframes flick { 0%,96%,100%{opacity:1;} 98%{opacity:.85;} }
  .hactions { display:flex; align-items:center; gap:7px; }
  .expand { width:32px; height:32px; flex:none; border:1px solid var(--bd1); border-radius:9px; background:var(--surfA);
    color:var(--acc); cursor:pointer; display:flex; align-items:center; justify-content:center; transition:color .18s ease, border-color .18s ease, box-shadow .18s ease; }
  .expand:hover { border-color:var(--amber); color:var(--amber); box-shadow:0 0 10px -2px rgba(224,145,47,.6); }
  .expand.spin svg { animation:spin .6s ease; }
  @keyframes spin { from{transform:rotate(0);} to{transform:rotate(360deg);} }
  .expand svg { width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:1.6; }
  .mimg-head,.mimg-full { background-size:contain; background-position:center; background-repeat:no-repeat; }

  /* --- popover de fondo (imagen + intensidad) --- */
  .bgpop { display:none; position:absolute; top:56px; right:18px; z-index:20; width:232px; flex-direction:column; gap:10px;
    background:linear-gradient(160deg,rgba(47,32,21,.98),rgba(32,22,13,.99)); border:1px solid var(--bd2); border-radius:12px;
    padding:13px; box-shadow:0 12px 30px -8px rgba(0,0,0,.8); }
  .bgpop.show { display:flex; }
  .bgpop .bgtitle { font-family:var(--mono); font-size:10px; font-weight:600; letter-spacing:var(--track); text-transform:uppercase; color:var(--lab); }
  .bgpop .bgrow { display:flex; align-items:center; gap:8px; }
  .bgpop .bgval { font-family:var(--mono); font-size:11px; color:var(--acc); min-width:34px; text-align:right; }
  .bgpop input[type=range] { flex:1; accent-color:var(--amber); cursor:pointer; }
  .bgpop .bgbtns { display:flex; gap:8px; }
  .bgpop .bgb { flex:1; border:1px solid var(--bd2); border-radius:9px; background:var(--surfA); color:var(--acc);
    font-family:var(--mono); font-size:10.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; padding:8px 6px; cursor:pointer;
    transition:color .15s ease, border-color .15s ease, box-shadow .15s ease; }
  .bgpop .bgb:hover { border-color:var(--amber); color:var(--amber); box-shadow:0 0 10px -3px rgba(224,145,47,.6); }

  .field { display:flex; flex-direction:column; gap:6px; }
  .lbl { font-family:var(--mono); font-size:10px; font-weight:600; letter-spacing:var(--track); text-transform:uppercase; color:var(--lab); }
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
    border:1px solid var(--bd3); border-left:4px solid var(--bd3); border-radius:10px; padding:8px 10px 8px 11px; font-family:var(--mono); font-size:13px;
    transition:border-color .2s ease, background .2s ease; }
  .srow.has { cursor:pointer; }
  /* estado glanceable: barra lateral + tinte + punto */
  .srow.st-clean { border-left-color:#7ea874; }
  .srow.st-dirty { border-left-color:var(--amber); background:linear-gradient(90deg,rgba(224,145,47,.10),var(--surfB) 55%); }
  .srow.st-ahead { border-left-color:var(--amber); }
  .srow.st-warn  { border-left-color:var(--terra); background:linear-gradient(90deg,rgba(207,107,66,.12),var(--surfB) 55%); }
  .srow .dot { width:9px; height:9px; border-radius:50%; flex:none; background:var(--mut); }
  .st-clean .dot { background:#7ea874; box-shadow:0 0 9px rgba(126,168,116,.8); }
  .st-dirty .dot, .st-ahead .dot { background:var(--amber); box-shadow:0 0 9px rgba(224,145,47,.85); }
  .st-warn .dot { background:var(--terra); box-shadow:0 0 9px rgba(207,107,66,.85); }
  .srow .br { display:flex; align-items:center; gap:8px; flex:1 1 auto; min-width:0; color:var(--txt); font-weight:500;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .srow .br .ico { color:#c98b4a; }
  .srow .caret { color:var(--mut); font-size:10px; transition:transform .15s ease; }
  .srow.open .caret { transform:rotate(90deg); }
  .srow .repo { color:var(--mut); font-size:11px; }
  .srow .badges { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .badge { font-family:var(--mono); font-size:10px; font-weight:600; padding:3px 9px; border-radius:999px; }
  .badge.state { font-size:11px; font-weight:700; padding:4px 11px; }
  .b-clean{ color:var(--green); background:rgba(126,168,116,.16); border:1px solid rgba(126,168,116,.5); box-shadow:0 0 10px -2px rgba(126,168,116,.6);}
  .b-dirty{ color:#ffcf9a; background:rgba(224,145,47,.2); border:1px solid rgba(224,145,47,.65); box-shadow:0 0 10px -2px rgba(224,145,47,.6);}
  .b-up{ color:#f0d8a0; background:rgba(224,145,47,.14); border:1px solid rgba(224,145,47,.4);}
  .b-dn{ color:#e6b48a; background:rgba(207,107,66,.16); border:1px solid rgba(207,107,66,.45);}
  .b-noremote{ color:#f0a882; background:rgba(207,107,66,.18); border:1px solid rgba(207,107,66,.6);}
  .b-phantom{ color:#cbb892; background:rgba(143,118,87,.18); border:1px dashed rgba(185,138,82,.6);}
  .b-merged{ color:var(--green); background:rgba(126,168,116,.12); border:1px solid rgba(126,168,116,.4);}

  /* fila de commit con boton sugerir */
  .commitrow { display:flex; gap:8px; align-items:flex-start; }
  .commitrow .input { flex:1; }
  textarea.input { resize:none; min-height:38px; max-height:170px; line-height:1.45; overflow-y:auto; display:block; font-size:12.5px; }
  .sugg { width:40px; flex:none; border:1px solid var(--bd2); border-radius:10px; background:var(--surfA);
    color:var(--amber); font-size:16px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .sugg:hover { box-shadow:0 0 10px -3px rgba(224,145,47,.7); border-color:rgba(224,145,47,.5); }
  .sugg:disabled { opacity:.5; cursor:not-allowed; }
  .input.flash { animation:flash .7s ease; }
  @keyframes flash { 0%{box-shadow:0 0 0 2px rgba(224,145,47,.85);} 100%{box-shadow:0 0 0 1px rgba(224,145,47,0);} }

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
  .branchbar .blabel { font-family:var(--mono); font-size:10px; font-weight:600; letter-spacing:var(--track); text-transform:uppercase; color:var(--lab); flex:none; }
  .branchbar select { flex:1; }
  .newbr { width:38px; height:38px; flex:none; border:1px solid var(--bd2); border-radius:10px; background:var(--surfA);
    color:var(--amber); font-size:20px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .newbr:hover { box-shadow:0 0 10px -3px rgba(224,145,47,.7); border-color:rgba(224,145,47,.5); }
  /* boton "volver a main": aparece solo cuando estas fuera de la rama principal */
  .gotomain { height:38px; flex:none; padding:0 12px; border:1px solid rgba(224,145,47,.5); border-radius:10px;
    background:var(--grad); color:#2a1503; font-family:var(--mono); font-size:12px; font-weight:700; line-height:1;
    cursor:pointer; display:flex; align-items:center; gap:6px; box-shadow:0 0 14px -6px rgba(224,145,47,.7); }
  .gotomain:hover { filter:brightness(1.05); box-shadow:0 0 18px -4px rgba(224,145,47,.85); }

  /* divisor */
  .divider { display:flex; align-items:center; gap:10px; }
  .divider::before,.divider::after { content:""; flex:1; height:1px; background:linear-gradient(90deg,transparent,var(--bd1)); }
  .divider::after { background:linear-gradient(90deg,var(--bd1),transparent); }
  .divider span { font-family:var(--mono); font-size:9px; font-weight:600; letter-spacing:var(--track); text-transform:uppercase; color:var(--mut); }

  /* botones tarjeta */
  .cards { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .cardbtn { position:relative; display:flex; align-items:center; gap:10px; text-align:left; border-radius:11px; padding:10px 11px; cursor:pointer;
    border:1px solid var(--bd2); transition:transform .07s ease, box-shadow .2s ease, filter .2s ease, border-color .2s ease, background .2s ease; }
  .cardbtn .ic { width:28px; height:28px; flex:none; border-radius:8px; display:flex; align-items:center; justify-content:center; }
  .cardbtn .ic svg { width:15px; height:15px; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .cardbtn .tx { display:flex; flex-direction:column; min-width:0; line-height:1.15; }
  .cardbtn .tx b { font-family:var(--sans); font-size:12px; font-weight:600; }
  .cardbtn .tx small { font-family:var(--mono); font-size:9px; margin-top:2px; letter-spacing:.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cardbtn:active { transform:translateY(1px); }
  .cardbtn:disabled { filter:grayscale(.4) brightness(.7); cursor:not-allowed; }

  /* secundarios (Check / Pull): superficie calida + acento ambar */
  .c-check, .c-pull { background:var(--grad-soft); border-color:var(--bd2); color:var(--amber); }
  .c-check .ic, .c-pull .ic { background:rgba(224,145,47,.14); }
  .c-check .tx b, .c-pull .tx b { color:var(--txt); }
  .c-check .tx small, .c-pull .tx small { color:var(--lab); }
  .c-check:hover, .c-pull:hover { border-color:rgba(224,145,47,.55); box-shadow:0 0 14px -5px rgba(224,145,47,.6); }

  /* primarios (Commit / Push): degradado ambar de marca */
  .c-commit, .c-push { background:var(--grad); border-color:rgba(224,145,47,.5); color:#2a1503; box-shadow:0 0 16px -6px rgba(224,145,47,.6); }
  .c-commit .ic, .c-push .ic { background:rgba(0,0,0,.14); }
  .c-commit .tx b, .c-push .tx b { color:#2a1503; font-weight:700; }
  .c-commit .tx small, .c-push .tx small { color:#2a1503; opacity:.72; }
  .c-commit:hover, .c-push:hover { box-shadow:0 0 20px -4px rgba(224,145,47,.85); filter:brightness(1.04); }

  /* estado HECHO: cualquier boton se pone verde con el visto tras la accion */
  .cardbtn.done { background:linear-gradient(160deg,#20291b,#1a2216) !important; border-color:rgba(143,191,122,.6) !important;
    box-shadow:0 0 16px -5px rgba(143,191,122,.5) !important; }
  .cardbtn.done .ic { background:rgba(143,191,122,.18) !important; color:var(--ok) !important; }
  .cardbtn.done .ic svg { display:none; }
  .cardbtn.done .ic::after { content:"\\2713"; font-size:17px; font-weight:700; line-height:1; color:var(--ok); }
  .cardbtn.done .tx b { color:#dcecd0 !important; }
  .cardbtn.done .tx small { color:var(--ok) !important; }

  /* burbuja mascota + feedback */
  .bubble { display:flex; gap:10px; background:var(--surfC); border:1px solid var(--bd4); border-left:3px solid var(--amber);
    border-radius:12px; padding:11px 12px; }
  .bot { width:44px; height:44px; flex:none; align-self:flex-start; animation:bob 3.4s ease-in-out infinite; transform-origin:60% 90%; }
  @keyframes bob { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-2px);} }
  .bot.working { animation:work .5s ease-in-out infinite; filter:drop-shadow(0 0 6px rgba(224,145,47,.6)); }
  @keyframes work { 0%{transform:translateY(0) rotate(-5deg);} 50%{transform:translateY(-3px) rotate(5deg);} 100%{transform:translateY(0) rotate(-5deg);} }
  .screen { flex:1; min-width:0; max-height:90px; overflow-y:auto; font-family:var(--sans); font-size:12.5px; line-height:1.45; color:var(--txt2); }
  .screen div { white-space:pre-wrap; word-break:break-word; }
  .screen .greet b, .info b { color:var(--amber); }
  .ok{color:var(--green);} .warn{color:var(--amber);} .err{color:var(--terra);}
  .dim{color:var(--mut);} .hdr{color:#e0a35c;font-weight:600;} .info{color:var(--txt2);}
  .mono { font-family:var(--mono); }

  .cancelbtn { display:none; width:100%; border:1px solid rgba(207,107,66,.6); border-radius:10px;
    background:rgba(207,107,66,.16); color:#f0a882; font-family:var(--mono); font-size:11px; font-weight:600;
    letter-spacing:var(--track); text-transform:uppercase; padding:9px 10px; cursor:pointer; }
  .cancelbtn:hover { background:rgba(207,107,66,.26); box-shadow:0 0 12px -4px rgba(207,107,66,.7); }
  .cancelbtn.show { display:block; }
</style>
</head>
<body>
  <div class="panel">
    <div class="header">
      <div class="brand">
        <div class="logo mimg-head"></div>
        <div class="wordmark">Brew</div>
      </div>
      <div class="hactions">
        <button class="expand" id="refresh" title="Actualizar estado">
          <svg viewBox="0 0 20 20"><path d="M3 10a7 7 0 0 1 12-5l2 2M17 10a7 7 0 0 1-12 5l-2-2M15 3v4h-4M5 17v-4h4"/></svg>
        </button>
        <button class="expand" id="rescan" title="Re-escanear proyectos">
          <svg viewBox="0 0 20 20"><circle cx="9" cy="9" r="5"/><path d="M17 17l-4-4"/></svg>
        </button>
        <button class="expand" id="setbg" title="Cambiar fondo y transparencia">
          <svg viewBox="0 0 20 20"><rect x="3" y="4.5" width="14" height="11" rx="2"/><circle cx="7.5" cy="9" r="1.4"/><path d="M4 15l4-4 3 3 2-2 3 3"/></svg>
        </button>
        <button class="expand" id="popout" title="Abrir en ventana flotante">
          <svg viewBox="0 0 20 20"><path d="M8 3H3v5M12 17h5v-5M3 3l6 6M17 17l-6-6"/></svg>
        </button>
      </div>
    </div>

    <div class="bgpop" id="bgpop">
      <div class="bgtitle">Fondo del panel</div>
      <div class="bgrow">
        <input type="range" id="bgrange" min="0" max="50" value="10" title="Intensidad del fondo">
        <span class="bgval" id="bgval">10%</span>
      </div>
      <div class="bgbtns">
        <button class="bgb" id="bgpick">Elegir imagen&hellip;</button>
        <button class="bgb" id="bgreset">Restaurar</button>
      </div>
    </div>

    <div class="field">
      <label class="lbl">Proyecto</label>
      <select id="project"></select>
    </div>

    <div class="status" id="status"></div>

    <div class="branchbar" id="branchbar" style="display:none;">
      <span class="blabel">Rama</span>
      <select id="branchsel"></select>
      <button class="gotomain" id="gotomain" title="Volver a la rama principal" style="display:none;">&#8962;</button>
      <button class="newbr" id="newbranch" title="Crear rama nueva">&#43;</button>
    </div>

    <div class="divider"><span>Sincronizar con el remoto</span></div>

    <div class="cards">
      <button class="cardbtn c-check" id="check"><span class="ic"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></span><span class="tx"><b>Check</b><small>busca cambios</small></span></button>
      <button class="cardbtn c-pull" id="pull"><span class="ic"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-5-5m5 5l5-5M5 21h14"/></svg></span><span class="tx"><b>Pull</b><small>trae tu rama</small></span></button>
    </div>

    <div class="field">
      <label class="lbl">Tu trabajo</label>
      <div class="commitrow">
        <textarea class="input" id="msg" rows="1" placeholder="mensaje de commit&hellip;" maxlength="600"></textarea>
        <button class="sugg" id="suggest" title="Sugerir mensaje segun los cambios">&#10024;</button>
      </div>
    </div>

    <div class="cards">
      <button class="cardbtn c-commit" id="commit"><span class="ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/></svg></span><span class="tx"><b>Commit</b><small>guarda cambios</small></span></button>
      <button class="cardbtn c-push" id="push"><span class="ic"><svg viewBox="0 0 24 24"><path d="M12 21V9m0 0l-5 5m5-5l5 5M5 3h14"/></svg></span><span class="tx"><b>Push</b><small>sube a GitHub</small></span></button>
    </div>

    <button class="cancelbtn" id="cancel">&#9209; Cancelar operaci&oacute;n</button>

    <div class="bubble">
      <div class="bot mimg-full" id="bot"></div>
      <div class="screen" id="screen"><div class="greet">Buenas &#9749; Elige un <b>proyecto</b> y te digo en qu&eacute; <b>rama</b> andas.</div></div>
    </div>
  </div>

<script>
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
  function setBusy(b){ ['check','pull','commit','push','suggest'].forEach(id=>{ const el=$(id); if(el) el.disabled=b; }); sel.disabled=b;
    const bot=$('bot'); if(bot) bot.classList.toggle('working',b);
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
  $('suggest').addEventListener('click', ()=>{ if(!sel.value||!ensureSelection())return; clearScreen(); line('Analizando cambios…','dim'); vscode.postMessage({cmd:'suggest', project:sel.value, repos:selectedRepoNames()}); });
  $('cancel').addEventListener('click', ()=>{ line('Cancelando…','warn'); vscode.postMessage({cmd:'cancel'}); });
  function spin(el){ if(!el)return; el.classList.remove('spin'); void el.offsetWidth; el.classList.add('spin'); }
  $('rescan').addEventListener('click', ()=>{ spin($('rescan')); vscode.postMessage({cmd:'rescan'}); });
  $('refresh').addEventListener('click', ()=>{ spin($('refresh')); requestStatus(); });
  $('popout').addEventListener('click', ()=>vscode.postMessage({cmd:'popout'}));

  // --- fondo del panel (imagen + intensidad) ---
  function applyBackground(uri, opacity){
    const root=document.documentElement;
    if(uri) root.style.setProperty('--bgimg','url("'+uri+'")');
    if(typeof opacity==='number'){
      const v=Math.max(0.3, Math.min(0.97, 1-opacity)); root.style.setProperty('--veil', v.toFixed(3));
      const pct=Math.round(opacity*100); $('bgrange').value=pct; $('bgval').textContent=pct+'%';
    }
  }
  $('setbg').addEventListener('click', (e)=>{ e.stopPropagation(); $('bgpop').classList.toggle('show'); });
  document.addEventListener('click', (e)=>{ const p=$('bgpop'); if(p.classList.contains('show') && !p.contains(e.target) && e.target!==$('setbg') && !$('setbg').contains(e.target)) p.classList.remove('show'); });
  $('bgrange').addEventListener('input', ()=>{ const pct=parseInt($('bgrange').value,10)||0; $('bgval').textContent=pct+'%'; const v=Math.max(0.3,Math.min(0.97,1-pct/100)); document.documentElement.style.setProperty('--veil', v.toFixed(3)); });
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
    } else if(m.type==='suggest'){ msg.value=m.message; autogrow(); msg.focus(); msg.classList.add('flash'); setTimeout(()=>msg.classList.remove('flash'),700);
    } else if(m.type==='busy'){ setBusy(true);
    } else if(m.type==='done'){ setBusy(false); markDone();
    } else if(m.type==='background'){ applyBackground(m.uri, m.opacity);
    } else if(m.type==='log'){ if(m.level==='err') opHadError=true; line(m.text, m.level); }
  });

  vscode.postMessage({cmd:'ready'});
</script>
</body>
</html>`;
}

module.exports = { activate, deactivate };
