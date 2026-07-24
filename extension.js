const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { htmlEsc, veilFor, baseName, topDir, briefList, cap, isTest, isDoc, isStyle, isConfig, assistantHint, commitType } = require('./lib/logic');

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
      wv.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(__dirname, 'media'))] };
      wv.html = getHtml(wv);
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
      invalidateCache(); refreshProjectsAsync();
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
    vscode.workspace.onDidChangeWorkspaceFolders(() => { invalidateCache(); refreshProjectsAsync().then(autoSelect); }),
    // refresco en vivo del estado "sin commitear" al guardar/crear/borrar/renombrar archivos
    vscode.workspace.onDidSaveTextDocument(doc => onWorkspaceFileChange(doc.uri)),
    vscode.workspace.onDidCreateFiles(e => e.files.forEach(onWorkspaceFileChange)),
    vscode.workspace.onDidDeleteFiles(e => e.files.forEach(onWorkspaceFileChange)),
    vscode.workspace.onDidRenameFiles(e => e.files.forEach(f => onWorkspaceFileChange(f.newUri))),
    // provee el contenido "HEAD" de un archivo para el diff (git show), sin depender de que el repo este abierto
    vscode.workspace.registerTextDocumentContentProvider(BREW_SCHEME, brewDiffProvider),
    { dispose: disposeHeadWatchers }
  );

  // calienta la cache de proyectos con I/O asincrona al arrancar (no bloquea el host)
  refreshProjectsAsync();
}

function deactivate() {}

// Abre una copia como pestaÃ±a y la manda a una ventana flotante nueva.
function openPopout() {
  const panel = vscode.window.createWebviewPanel(
    'gitArcadePop', 'Git Arcade', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(path.join(__dirname, 'media'))] }
  );
  const wv = panel.webview;
  wv.html = getHtml(wv);
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
      case 'rescan': invalidateCache(); refreshProjectsAsync().then(autoSelect); break;
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
// (veilFor vive en lib/logic.js)
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

// raices a escanear + profundidad (segun config).
function scanRoots() {
  const maxDepth = cfg('scanDepth', 4);
  const rootPath = cfg('rootPath', path.join(os.homedir(), 'Documents', 'PROJECTS'));
  const extra = cfg('extraPaths', []) || [];
  const roots = [rootPath, ...extra].filter(Boolean);
  return { roots, rootsLower: roots.map(r => String(r).toLowerCase()), maxDepth };
}

// agrupa rutas de repos en proyectos (repos hermanos bajo una carpeta = un proyecto).
function groupRepos(repoPaths, rootsLower) {
  const seen = new Set(); const repos = [];
  for (const p of repoPaths) { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); repos.push(p); } }
  const groups = new Map();
  for (const repoPath of repos) {
    const parent = path.dirname(repoPath);
    const key = rootsLower.includes(parent.toLowerCase()) ? repoPath : parent;
    if (!groups.has(key)) groups.set(key, { name: path.basename(key), dir: key, repos: [] });
    groups.get(key).repos.push({ name: path.basename(repoPath), path: repoPath });
  }
  return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Version SINCRONA (fallback): la usa cualquier llamador sincrono con la cache fria.
function getProjects() {
  if (cachedProjects && (Date.now() - cacheTime) < PROJECTS_TTL) return cachedProjects;
  const { roots, rootsLower, maxDepth } = scanRoots();
  const found = [];
  for (const root of roots) scan(root, 0, maxDepth, found);
  cachedProjects = groupRepos(found, rootsLower);
  cacheTime = Date.now();
  return cachedProjects;
}

// Version ASINCRONA (proactiva): reconstruye la cache con I/O no bloqueante y avisa a los
// webviews. Se dispara al arrancar y al re-escanear, para que el escaneo no congele el host.
let refreshing = null;
async function refreshProjectsAsync() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const { roots, rootsLower, maxDepth } = scanRoots();
    const found = [];
    for (const root of roots) await scanAsync(root, 0, maxDepth, found);
    cachedProjects = groupRepos(found, rootsLower);
    cacheTime = Date.now();
  })();
  try { await refreshing; } finally { refreshing = null; }
  sendProjects();
}

function scan(dir, depth, maxDepth, out) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  if (entries.some(e => e.isDirectory() && e.name === '.git')) { out.push(dir); return; }
  for (const e of entries) {
    if (!e.isDirectory() || skipDir(e.name)) continue;
    scan(path.join(dir, e.name), depth + 1, maxDepth, out);
  }
}

async function scanAsync(dir, depth, maxDepth, out) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  if (entries.some(e => e.isDirectory() && e.name === '.git')) { out.push(dir); return; }
  for (const e of entries) {
    if (!e.isDirectory() || skipDir(e.name)) continue;
    await scanAsync(path.join(dir, e.name), depth + 1, maxDepth, out);
  }
}

// carpetas que no vale la pena recorrer buscando repos.
function skipDir(n) {
  return n === 'node_modules' || n === '.git' || n === 'dist' || n === 'build' ||
    n === '.next' || n === 'vendor' || n === '.venv' || n === '__pycache__';
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

// (htmlEsc y assistantHint viven ahora en lib/logic.js para poder testearlos)

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
//  (baseName/topDir/briefList/cap, los clasificadores y commitType estan en lib/logic.js)
// ---------------------------------------------------------------------------
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

  // --- tipo (Conventional Commits) ---
  const type = commitType({ paths, added, modified, deleted, renamed, fixSignal, featSignal });

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
function getHtml(webview) {
  const res = f => webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'media', f)));
  let bgVars = '';
  try { bgVars = ':root{--bgimg:url("' + currentBgUri() + '");--veil:' + veilFor(bgOpacity()) + ';}'; } catch (e) {}
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${res('fonts.css')}">
<link rel="stylesheet" href="${res('mascot.css')}">
<link rel="stylesheet" href="${res('panel.css')}">
<style>${bgVars}</style>
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

<script src="${res('panel.js')}"></script>
</body>
</html>`;
}

module.exports = { activate, deactivate };
