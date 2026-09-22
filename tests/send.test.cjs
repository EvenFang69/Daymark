const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/app.js'), 'utf8');

function setup() {
  const handlers = {};
  const storage = new Map();
  const hint = { setAttribute() {} };
  const button = { setAttribute() {}, disabled: false };
  const input = { value: 'A private test note', style: {}, scrollHeight: 50 };
  const form = { classList: { toggle() {} }, setAttribute() {}, querySelector: (s) => s === '.send-button' ? button : hint };
  const root = { dataset: {}, addEventListener: (name, fn) => { handlers[name] = fn; } };
  const nodes = { '#composer-input': input, '#composer-form': form, '#app': root };
  const context = vm.createContext({
    console, setTimeout, clearTimeout, AbortController, TypeError, crypto: webcrypto,
    window: { addEventListener() {} }, matchMedia: () => ({ matches: true }),
    document: { querySelector: (s) => nodes[s], activeElement: input },
    localStorage: { setItem: (k, v) => storage.set(k, v), getItem: (k) => storage.get(k) },
  });
  vm.runInContext(source + '\npatchEntryCard = () => {}; watchEntry = () => {};', context);
  const run = (code) => vm.runInContext(code, context);
  const submit = () => run('submitEntry({preventDefault() {}})');
  return { run, submit, context, input, hint, button, handlers, storage };
}

test('double tap sends once; typing the next note is preserved', async () => {
  const t = setup();
  let resolve, calls = 0;
  t.context.fetch = () => { calls++; return new Promise((r) => { resolve = r; }); };
  const first = t.submit();
  assert.equal(t.hint.textContent, '正在保存…');
  assert.equal(t.button.disabled, true);
  await t.submit();
  assert.equal(calls, 1);
  t.input.value = 'Next note';
  t.run('state.composer = "Next note"');
  resolve({ ok: true, json: async () => ({ entry: { id: 1 } }) });
  await first;
  assert.equal(t.input.value, 'Next note');
  assert.equal(t.button.disabled, false);
  assert.match(t.hint.textContent, /已保存/);
});

test('connection failure keeps draft and request ID across reload; retry clears acknowledged draft', async () => {
  const t = setup();
  let failedBody;
  t.context.fetch = async (_, options) => { failedBody = JSON.parse(options.body); throw new TypeError('offline'); };
  await t.submit();
  assert.equal(t.input.value, 'A private test note');
  assert.equal(t.button.disabled, false);
  assert.match(t.hint.textContent, /连不上/);
  t.run('state.composer = ""; state.pendingSend = null; restoreDraft()');
  assert.equal(t.run('state.composer'), t.input.value);
  t.context.fetch = async (_, options) => {
    assert.equal(JSON.parse(options.body).request_id, failedBody.request_id);
    return { ok: true, json: async () => ({ entry: { id: 2 } }) };
  };
  await t.submit();
  assert.equal(t.input.value, '');
  assert.equal(JSON.parse(t.storage.get('journal-composer')).pending, null);
});

test('a hung request expires and releases the send button', async () => {
  const t = setup();
  t.context.fetch = (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject({ name: 'AbortError' }));
  });
  t.run('const realApi = api; api = (p, o) => realApi(p, {...o, timeoutMs: 10})');
  await t.submit();
  assert.match(t.hint.textContent, /暂未收到保存确认/);
  assert.equal(t.button.disabled, false);
  assert.ok(t.run('state.pendingSend'));
});

test('invalid server confirmation never clears the draft', async () => {
  const t = setup();
  t.context.fetch = async () => ({ ok: true, json: async () => ({}) });
  await t.submit();
  assert.equal(t.input.value, 'A private test note');
  assert.equal(t.button.disabled, false);
  assert.match(t.hint.textContent, /草稿已保留/);
});

test('mobile Enter stays multiline; tap preserves focus and enters submit path', async () => {
  const t = setup();
  t.run('bindApp()');
  let prevented = false;
  const key = { target: { matches: () => true }, key: 'Enter', preventDefault() { prevented = true; } };
  t.handlers.keydown(key);
  assert.equal(prevented, false);
  const tap = { target: { closest: () => t.button }, preventDefault() { prevented = true; } };
  t.handlers.pointerdown(tap);
  assert.equal(prevented, true);
  let calls = 0;
  t.context.fetch = async () => { calls++; return { ok: true, json: async () => ({ entry: { id: 3 } }) }; };
  t.handlers.click(tap);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(t.input.value, '');
});
