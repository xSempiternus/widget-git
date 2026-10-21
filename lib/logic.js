// Logica pura de Brew (sin dependencias de `vscode`), extraida para poder testearla
// con `node --test`. extension.js la consume via require('./lib/logic').

// Escapa texto (nombres de rama/repo, que git permite con < > & ") antes de meterlo en HTML.
function htmlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Velo oscuro sobre la imagen de fondo: a mayor intensidad (p), menor velo. Clampa a [0.3, 0.97].
function veilFor(p) { return Math.max(0.3, Math.min(0.97, 1 - p)).toFixed(3); }

// --- helpers de nombres/rutas (para la sugerencia de commit) ---
function baseName(p) { return p.split('/').pop().replace(/"/g, ''); }
function topDir(p) { const parts = p.split('/'); return parts.length > 1 ? parts[0] : ''; }
function briefList(names, max) {
  const u = Array.from(new Set(names)); max = max || 2;
  if (u.length === 1) return u[0];
  if (u.length <= max) return u.slice(0, -1).join(', ') + ' y ' + u[u.length - 1];
  return `${u.slice(0, max).join(', ')} y ${u.length - max} mas`;
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// --- clasificadores de archivo (por ruta) ---
const isTest = p => /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.[a-z]+$/i.test(p);
const isDoc = p => /\.(md|mdx|rst|txt)$/i.test(p) || /(^|\/)docs?\//i.test(p);
const isStyle = p => /\.(css|scss|sass|less|styl)$/i.test(p);
const isConfig = p => /(package(-lock)?\.json|yarn\.lock|pnpm-lock\.ya?ml|\.ya?ml|\.toml|dockerfile|\.dockerignore|\.gitignore|\.env|tsconfig|\.eslintrc|\.prettier|vite\.config|webpack|babel\.config)/i.test(p);

// Mensaje proactivo de la mascota-asistente segun el estado agregado de los repos.
// El orden importa: los casos "trampa" (donde Push seria un error) van PRIMERO.
// `results` es un array de { name, branch, main, hasRemote, hasUp, remoteHasBranch,
//   dirty, ahead, behind, onMain, mergedInMain, phantomAhead }.
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

  const phantom = results.filter(r => r.phantomAhead);
  if (phantom.length) {
    const r = phantom[0]; const rb = htmlEsc(r.branch), rm = htmlEsc(r.main);
    return `Est&aacute;s en <b>${rb}</b> con <b>${r.ahead} &laquo;commit(s) sin pushear&raquo;</b>, pero esos commits <b>ya est&aacute;n en el servidor dentro de <span class="mono">${rm}</span></b>. &laquo;ahead&raquo; compara punteros, no mide tu trabajo: es una etiqueta vieja apuntando atr&aacute;s. <b>No hagas Push.</b> Dale <b>&#8962; Ir a ${rm}</b>.`;
  }

  const realAhead = results.reduce((s, r) => s + ((r.phantomAhead) ? 0 : r.ahead), 0);
  if (realAhead > 0) return `Tienes <b>${realAhead} commit(s) sin pushear</b> &#8593; &mdash; dale <b>Push</b> para subirlos.`;

  const linkNeeded = noUp.filter(r => r.remoteHasBranch);
  if (linkNeeded.length) {
    const r = linkNeeded[0];
    return `Tu rama <b>ya existe en GitHub</b> pero no est&aacute; enlazada (por eso VS Code dice &laquo;Publish Branch&raquo;). Enl&aacute;zala: <span class="mono">git branch --set-upstream-to=origin/${htmlEsc(r.branch)}</span> y luego <b>Pull</b>. No uses Publish.`;
  }
  if (noUp.length) return `Tu rama es <b>nueva</b> (no est&aacute; en el remoto) &#8593; &mdash; dale <b>Push</b> y la creo en GitHub.`;
  if (behind > 0) return `Hay <b>${behind} commit(s) nuevo(s)</b> en el remoto &#8595; &mdash; dale <b>Pull</b>.`;

  const merged = results.filter(r => r.mergedInMain && !r.onMain);
  if (merged.length) {
    const r = merged[0]; const rb = htmlEsc(r.branch), rm = htmlEsc(r.main);
    return `<b>${rb}</b> ya est&aacute; <b>fusionada en <span class="mono">${rm}</span></b>: su trabajo ya vive ah&iacute;. Puedes volver con <b>&#8962; Ir a ${rm}</b> sin perder nada.`;
  }
  return `Todo al d&iacute;a &#10024; &iquest;un cafecito? &#9749;`;
}

// Deduce el tipo de commit (Conventional Commits) a partir de la clasificacion de cambios.
// Extraido de suggestMessage para poder testearlo. `c` = { paths, added, modified, deleted,
//   renamed, fixSignal, featSignal } (arrays y booleanos).
function commitType(c) {
  const { paths, added, modified, deleted, renamed, fixSignal, featSignal } = c;
  if (paths.length && paths.every(isDoc)) return 'docs';
  if (paths.length && paths.every(isTest)) return 'test';
  if (paths.length && paths.every(isStyle)) return 'style';
  if (paths.length && paths.every(isConfig)) return 'chore';
  if (fixSignal && !added.length) return 'fix';
  if (added.length && (featSignal || !modified.length)) return 'feat';
  if (deleted.length && !added.length && !modified.length) return 'chore';
  if (renamed.length && !added.length && !modified.length) return 'refactor';
  if (fixSignal) return 'fix';
  return 'refactor';
}

// --- helpers para la sugerencia con IA (prompt/limpieza), extraidos para testear ---

// Archivos "ruido" para la IA: lockfiles, minificados, mapas y carpetas generadas. Su diff no
// aporta intencion y suele comerse el presupuesto de tokens del modelo.
const isNoise = p => /(package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|out|vendor|node_modules|coverage|__snapshots__)\/)/i.test(p);

// Prioridad de "senal" de un archivo para el modelo: el codigo importa mas que config/estilo/docs.
function diffRank(p) {
  if (isDoc(p)) return 1;
  if (isStyle(p) || isConfig(p)) return 2;
  if (isTest(p)) return 3;
  return 5;
}

// Arma el texto de diff que ve la IA a partir de bloques por archivo ({repo, path, text}):
// descarta ruido (lockfiles/generados), ORDENA por senal (codigo antes que docs/config) para que,
// si hay que recortar al `cap`, se sacrifique primero lo menos util, y antepone "# repo:" en multi-repo.
function assembleDiff(blocks, cap, multiRepo) {
  cap = cap || 12000;
  if (!blocks || !blocks.length) return '';
  const ordered = blocks
    .filter(b => b && b.text && !isNoise(b.path || ''))
    .map((b, i) => ({ b, i, r: diffRank(b.path || '') }))
    .sort((a, b) => (b.r - a.r) || (a.i - b.i));
  let out = '', used = 0;
  for (const { b } of ordered) {
    if (used >= cap) break;
    const hdr = multiRepo && b.repo ? `# repo: ${b.repo}\n` : '';
    const chunk = hdr + b.text;
    const slice = chunk.slice(0, cap - used);
    out += slice; used += slice.length;
  }
  return out;
}

// Divide la salida de `git diff` en bloques por archivo. git separa cada archivo con "diff --git a/X b/Y".
function splitDiffFiles(diff) {
  if (!diff) return [];
  return String(diff).split(/(?=^diff --git )/m).filter(b => b.trim()).map(text => {
    const m = text.match(/^diff --git a\/(.+?) b\//m);
    return { path: m ? m[1] : '', text };
  });
}

// Detecta el idioma probable (es/en) de una lista de asuntos de commit, para que la IA escriba igual.
function detectLang(subjects) {
  const t = (subjects || []).join(' ').toLowerCase();
  if (!t.trim()) return 'es';
  let es = 0, en = 0;
  if (/[áéíóúñ¿¡]/.test(t)) es += 3;
  (t.match(/\b(agrega|actualiza|corrige|elimina|refactoriza|mejora|a[ñn]ade|crea|arregla|cambia|con|de|para|los|las|del|mensaje)\b/g) || []).forEach(() => es++);
  (t.match(/\b(add|adds|added|fix|fixes|update|updates|remove|refactor|improve|create|change|with|the|and|for|from)\b/g) || []).forEach(() => en++);
  return en > es ? 'en' : 'es';
}

// Elige el modelo de chat mas capaz de los disponibles (VSCode LanguageModelChat u objetos {family,id,name}).
// Prefiere familias potentes; ante empate respeta el orden original que da el editor.
function pickChatModel(models) {
  if (!models || !models.length) return null;
  const rank = m => {
    const s = `${m.family || ''} ${m.id || ''} ${m.name || ''}`.toLowerCase();
    if (/gpt-3\.5|mini|haiku|nano|lite/.test(s)) return 0;
    if (/o[13]|gpt-4o|gpt-4\.1|gpt-5|claude.*(3\.5|3-5|3\.7|sonnet|opus|4)|gemini.*(1\.5|2)/.test(s)) return 3;
    if (/gpt-4|claude|gemini/.test(s)) return 2;
    return 1;
  };
  return models
    .map((m, i) => ({ m, i, r: rank(m) }))
    .sort((a, b) => (b.r - a.r) || (a.i - b.i))[0].m;
}

// Normaliza la respuesta cruda del modelo a un mensaje de commit limpio:
// quita cercos de codigo/comillas/preambulos, fuerza asunto <=72 sin punto final y colapsa
// lineas en blanco del cuerpo. `type`/`scope` se anteponen si el asunto no trae ya prefijo.
function normalizeCommitMessage(text, opts) {
  opts = opts || {};
  let t = String(text == null ? '' : text).trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  t = t.replace(/^(commit message|mensaje de commit|aqu[ií] tienes[^:\n]*)\s*:\s*/i, '').trim();
  if (!t) return '';
  const lines = t.split('\n');
  let subject = (lines.shift() || '').trim();
  subject = subject.replace(/^["'`“”]+|["'`“”]+$/g, '').replace(/\.\s*$/, '').trim();
  if (opts.convStyle && opts.type && !/^[a-z]+(\([^)]*\))?!?:/i.test(subject)) {
    const sc = opts.scope ? `(${opts.scope})` : '';
    subject = `${opts.type}${sc}: ${subject}`;
  }
  if (subject.length > 72) subject = subject.slice(0, 69).trimEnd() + '...';
  const body = lines.join('\n').replace(/^\s*\n+/, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  return body ? `${subject}\n\n${body}` : subject;
}

// --- agrupacion de repos en proyectos ---

// Carpeta "categoria" (02_Clientes, 03_Startups-Propios...): ordena proyectos, no ES uno.
const isCategoryName = n => /^\d+[\s._-]/.test(n);

// Agrupa rutas de repos en proyectos. Repos hermanos bajo una misma carpeta forman un proyecto
// (p.ej. Fidelya/ con backend y frontend), salvo que esa carpeta sea una categoria:
//  - su nombre empieza con numero (02_Clientes), o
//  - ademas de repos tiene subcarpetas con mas repos adentro y ningun repo se llama como ella
//    (03_Startups-Propios/ml-trader + deliryum-ai/BermGuard): mezcla proyectos distintos.
// Un repo que queda solo se muestra con SU nombre (BermGuard), no con el de su carpeta.
// Si dos proyectos quedan con el mismo nombre se desambiguan con la carpeta padre.
// `p` es el modulo path (inyectable para testear rutas posix o win32).
function groupRepos(repoPaths, rootsLower, p) {
  p = p || require('path');
  const lower = s => String(s).toLowerCase();
  const seen = new Set(); const repos = [];
  for (const r of repoPaths) { const k = lower(r); if (!seen.has(k)) { seen.add(k); repos.push(r); } }

  const byParent = new Map();
  for (const r of repos) {
    const k = lower(p.dirname(r));
    if (!byParent.has(k)) byParent.set(k, { dir: p.dirname(r), repos: [] });
    byParent.get(k).repos.push(r);
  }
  const isGroup = (k, g) => {
    if (g.repos.length < 2 || rootsLower.includes(k)) return false;
    const name = lower(p.basename(g.dir));
    if (isCategoryName(name)) return false;
    const nested = repos.some(r => { const d = lower(p.dirname(r)); return d !== k && d.startsWith(k + p.sep); });
    return !nested || g.repos.some(r => lower(p.basename(r)).includes(name));
  };

  const out = [];
  for (const [k, g] of byParent) {
    const entries = g.repos.map(r => ({ name: p.basename(r), path: r }));
    if (isGroup(k, g)) out.push({ name: p.basename(g.dir), dir: g.dir, repos: entries });
    else for (const e of entries) out.push({ name: e.name, dir: e.path, repos: [e] });
  }

  const count = new Map();
  for (const x of out) count.set(lower(x.name), (count.get(lower(x.name)) || 0) + 1);
  for (const x of out) if (count.get(lower(x.name)) > 1) x.name = `${x.name} (${p.basename(p.dirname(x.dir))})`;
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { htmlEsc, veilFor, baseName, topDir, briefList, cap, isTest, isDoc, isStyle, isConfig, assistantHint, commitType, isNoise, diffRank, assembleDiff, splitDiffFiles, detectLang, pickChatModel, normalizeCommitMessage, groupRepos };
