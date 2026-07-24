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

module.exports = { htmlEsc, veilFor, baseName, topDir, briefList, cap, isTest, isDoc, isStyle, isConfig, assistantHint, commitType };
