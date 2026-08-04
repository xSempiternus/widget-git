// Tests de la logica pura de Brew. Se ejecutan con `node --test` (sin dependencias).
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/logic');

// helper para construir un "repo result" con valores por defecto sanos
function repo(over) {
  return Object.assign({
    name: 'repo', branch: 'main', main: 'main', hasRemote: true, hasUp: true,
    remoteHasBranch: true, dirty: 0, ahead: 0, behind: 0, onMain: true,
    mergedInMain: false, phantomAhead: false
  }, over || {});
}

test('htmlEsc escapa caracteres peligrosos', () => {
  assert.strictEqual(L.htmlEsc('<img src=x onerror=y>'), '&lt;img src=x onerror=y&gt;');
  assert.strictEqual(L.htmlEsc('a & "b" \'c\''), 'a &amp; &quot;b&quot; &#39;c&#39;');
  assert.strictEqual(L.htmlEsc(null), '');
  assert.strictEqual(L.htmlEsc(undefined), '');
});

test('veilFor invierte la intensidad y clampa a [0.3, 0.97]', () => {
  assert.strictEqual(L.veilFor(0), '0.970');     // sin imagen -> velo maximo
  assert.strictEqual(L.veilFor(1), '0.300');     // imagen plena -> velo minimo
  assert.strictEqual(L.veilFor(0.14), '0.860');
});

test('baseName y topDir', () => {
  assert.strictEqual(L.baseName('src/ui/panel.js'), 'panel.js');
  assert.strictEqual(L.baseName('"quoted".js'), 'quoted.js');
  assert.strictEqual(L.topDir('src/ui/panel.js'), 'src');
  assert.strictEqual(L.topDir('README.md'), '');
});

test('briefList resume nombres', () => {
  assert.strictEqual(L.briefList(['a']), 'a');
  assert.strictEqual(L.briefList(['a', 'b']), 'a y b');
  assert.strictEqual(L.briefList(['a', 'b', 'c', 'd']), 'a, b y 2 mas');
  assert.strictEqual(L.briefList(['a', 'a', 'b']), 'a y b');  // deduplica
});

test('cap capitaliza', () => {
  assert.strictEqual(L.cap('hola'), 'Hola');
  assert.strictEqual(L.cap(''), '');
});

test('clasificadores de archivo', () => {
  assert.ok(L.isDoc('README.md'));
  assert.ok(L.isDoc('docs/guia.txt'));
  assert.ok(!L.isDoc('src/app.js'));
  assert.ok(L.isStyle('media/panel.css'));
  assert.ok(L.isTest('src/__tests__/x.js'));
  assert.ok(L.isTest('app.test.js'));
  assert.ok(L.isConfig('package.json'));
  assert.ok(L.isConfig('tsconfig.json'));
  assert.ok(!L.isConfig('src/index.js'));
});

test('commitType: solo docs -> docs', () => {
  assert.strictEqual(L.commitType({ paths: ['README.md', 'docs/x.md'], added: [], modified: [{}], deleted: [], renamed: [], fixSignal: false, featSignal: false }), 'docs');
});

test('commitType: senal de fix sin altas -> fix', () => {
  assert.strictEqual(L.commitType({ paths: ['src/a.js'], added: [], modified: [{}], deleted: [], renamed: [], fixSignal: true, featSignal: false }), 'fix');
});

test('commitType: altas con senal feat -> feat', () => {
  assert.strictEqual(L.commitType({ paths: ['src/a.js'], added: [{}], modified: [], deleted: [], renamed: [], fixSignal: false, featSignal: true }), 'feat');
});

test('commitType: por defecto -> refactor', () => {
  assert.strictEqual(L.commitType({ paths: ['src/a.js'], added: [], modified: [{}], deleted: [], renamed: [], fixSignal: false, featSignal: false }), 'refactor');
});

// --- assistantHint: el ORDEN de prioridad es lo critico (los casos "trampa" van primero) ---

test('assistantHint: sin remoto tiene prioridad', () => {
  const h = L.assistantHint('p', [repo({ hasRemote: false })]);
  assert.match(h, /no est&aacute; conectado a un remoto/);
});

test('assistantHint: cambios sin commitear antes que ahead', () => {
  const h = L.assistantHint('p', [repo({ dirty: 3, ahead: 2 })]);
  assert.match(h, /sin commitear/);
});

test('assistantHint: ahead fantasma avisa de NO pushear', () => {
  const h = L.assistantHint('p', [repo({ branch: 'feature', dirty: 0, ahead: 2, phantomAhead: true })]);
  assert.match(h, /No hagas Push/);
});

test('assistantHint: ahead real sugiere Push', () => {
  const h = L.assistantHint('p', [repo({ dirty: 0, ahead: 2, phantomAhead: false })]);
  assert.match(h, /sin pushear/);
  assert.match(h, /Push/);
});

test('assistantHint: rama ya en remoto sin upstream -> enlazar, no publicar', () => {
  const h = L.assistantHint('p', [repo({ hasUp: false, remoteHasBranch: true, dirty: 0 })]);
  assert.match(h, /ya existe en GitHub/);
});

test('assistantHint: behind -> Pull', () => {
  const h = L.assistantHint('p', [repo({ dirty: 0, behind: 4 })]);
  assert.match(h, /Pull/);
});

test('assistantHint: rama fusionada limpia -> volver a main', () => {
  const h = L.assistantHint('p', [repo({ branch: 'feature', dirty: 0, onMain: false, mergedInMain: true })]);
  assert.match(h, /fusionada/);
});

test('assistantHint: todo al dia', () => {
  const h = L.assistantHint('p', [repo({ dirty: 0 })]);
  assert.match(h, /Todo al d&iacute;a/);
});

test('assistantHint: escapa nombres de rama con HTML', () => {
  const h = L.assistantHint('p', [repo({ hasRemote: false, name: '<script>' })]);
  assert.match(h, /&lt;script&gt;/);
  assert.ok(!h.includes('<script>'));
});

// --- helpers de la sugerencia con IA ---

test('isNoise detecta lockfiles y generados', () => {
  assert.ok(L.isNoise('package-lock.json'));
  assert.ok(L.isNoise('sub/yarn.lock'));
  assert.ok(L.isNoise('dist/bundle.js'));
  assert.ok(L.isNoise('media/app.min.css'));
  assert.ok(L.isNoise('build/app.js.map'));
  assert.ok(!L.isNoise('src/index.js'));
});

test('stripNoiseFromDiff quita solo los bloques ruido', () => {
  const diff = [
    'diff --git a/src/app.js b/src/app.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/package-lock.json b/package-lock.json',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    ''
  ].join('\n');
  const out = L.stripNoiseFromDiff(diff);
  assert.match(out, /src\/app\.js/);
  assert.ok(!out.includes('package-lock.json'));
  assert.strictEqual(L.stripNoiseFromDiff(''), '');
});

test('pickChatModel prefiere el modelo mas capaz', () => {
  const models = [
    { id: 'gpt-3.5-turbo', family: 'gpt-3.5' },
    { id: 'gpt-4o', family: 'gpt-4o' },
    { id: 'claude-3.5-sonnet', family: 'claude-3.5-sonnet' }
  ];
  assert.strictEqual(L.pickChatModel(models).id, 'gpt-4o'); // primero de rango alto gana el empate
  assert.strictEqual(L.pickChatModel([]), null);
  assert.strictEqual(L.pickChatModel(null), null);
});

test('normalizeCommitMessage limpia cercos, comillas y punto final', () => {
  const raw = '```\n"Actualiza el panel."\n\n\n- ajusta css\n```';
  const out = L.normalizeCommitMessage(raw, {});
  assert.strictEqual(out, 'Actualiza el panel\n\n- ajusta css');
});

test('normalizeCommitMessage recorta asunto a 72 y antepone tipo/scope', () => {
  const long = 'a'.repeat(100);
  const out = L.normalizeCommitMessage(long, { convStyle: true, type: 'feat', scope: 'ui' });
  const subject = out.split('\n')[0];
  assert.ok(subject.length <= 72);
  assert.match(subject, /^feat\(ui\): /);
  // si ya trae prefijo, no lo duplica
  const out2 = L.normalizeCommitMessage('fix(api): corrige token', { convStyle: true, type: 'feat', scope: 'ui' });
  assert.strictEqual(out2, 'fix(api): corrige token');
});
