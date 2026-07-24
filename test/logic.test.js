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
