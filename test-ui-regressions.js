// Regression tests for client behaviour. Browser visual QA complements these DOM stubs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, 'public', 'assets', name), 'utf8');
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

function harness(handler = () => ({}), search = '') {
  const elements = new Map(), calls = [], redirects = [];
  const buttons = { 'cow-form': 'cow-submit', 'event-form': 'event-submit', 'login-form': 'login-submit',
    'scc-form': 'scc-submit', 'decision-form': 'decision-submit' };
  let start;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', checked: false, disabled: false, hidden: false, required: false,
      dataset: {}, listeners: {}, textContent: '', innerHTML: '', children: [], selectedOptions: [],
      addEventListener(name, callback) { this.listeners[name] = callback; },
      appendChild(child) { this.children.push(child); },
      dispatchEvent(event) { this.listeners[event.type]?.(event); },
      focus() {}, scrollIntoView() {},
      querySelector() { return element(buttons[id] || `${id}-button`); },
      querySelectorAll(selector) {
        if (id === 'cow-list' && selector === '.edit-cow') return [1, 2].map(cowId => {
          const button = element(`edit-cow-${cowId}`); button.dataset.id = String(cowId); return button;
        });
        return [];
      },
      reset() {
        for (const key of ['tag_number', 'breed', 'birth_date', 'lactation_number', 'cow-edit-id', 'notes', 'event-edit-id']) element(key).value = '';
        element('status').value = 'lactating';
      }
    });
    return elements.get(id);
  }
  const document = {
    readyState: 'complete', body: { dataset: {} }, getElementById: element,
    querySelector: selector => selector === '.app-shell' ? null : element(selector.replace(/^#/, '')),
    querySelectorAll: () => [], createElement: () => ({ dataset: {}, value: '', textContent: '' }),
    addEventListener(name, callback) { if (name === 'DOMContentLoaded') start = callback; }
  };
  const context = vm.createContext({ document, URL, URLSearchParams, Event,
    window: { location: { pathname: '/herd.html', search, origin: 'http://localhost:4001', assign: url => redirects.push(url) } },
    fetch: async (url, options) => { calls.push({ url, options }); return handler(url, options); }
  });
  vm.runInContext(read('app.js'), context);
  const api = context.window.CalvingLog;
  function run(script) {
    vm.runInContext(read(script), context);
    return start();
  }
  return { api, context, element, calls, redirects, run };
}
const response = (body, status = 200, type = 'application/json') => ({ ok: status < 400, status,
  headers: { get: () => type }, json: async () => body });
const submit = { preventDefault() {} };

test('repeated busy calls preserve the original label and disabled state', () => {
  const { api, element } = harness(); const button = element('save'); button.textContent = 'Save';
  api.setBusy(button, true); api.setBusy(button, true, 'Again'); api.setBusy(button, false);
  assert.equal(button.textContent, 'Save'); assert.equal(button.disabled, false);
  button.disabled = true; api.setBusy(button, true); api.setBusy(button, false);
  assert.equal(button.disabled, true);
});
test('busy restoration is a no-op after a form has intentionally changed its label', () => {
  const { api, element } = harness(); const button = element('save'); button.textContent = 'Save changes';
  api.setBusy(button, true); api.setBusy(button, false); button.textContent = 'Add cow'; api.setBusy(button, false);
  assert.equal(button.textContent, 'Add cow');
});
test('unexpected HTML API responses produce a useful error rather than a later null dereference', async () => {
  const { api } = harness(() => response(null, 200, 'text/html'));
  await assert.rejects(api.requestJson('/api/cows'), /unexpected response/);
});
test('successful empty logout and delete responses do not become frontend errors', async () => {
  for (const status of [204, 205]) {
    const { api } = harness(() => ({ ok: true, status, headers: { get: () => 'application/json' },
      json: async () => { throw new Error('Empty response must not be parsed'); } }));
    assert.equal(await api.requestJson('/api/auth/logout', { method: 'POST' }), null);
  }
});
test('date-only formatting stays UTC while audit timestamps are readable', () => {
  const { api } = harness();
  assert.match(api.formatDate('2026-10-04'), /4 October 2026/);
  assert.ok(!api.formatTimestamp('2026-10-04T04:28:45.888Z').includes('T04:28'));
  assert.equal(api.formatTimestamp('invalid'), 'invalid');
});

for (const [name, next, expected] of [
  ['relative internal path', '/herd.html?status=dry', '/herd.html?status=dry'],
  ['protocol-relative external URL', '//evil.example/path', '/'],
  ['backslash-normalised external URL', '/\\evil.example', '/'],
  ['absolute external URL', 'https://evil.example/', '/']
]) test(`login safely handles ${name}`, async () => {
  const ui = harness(() => response({}), `?next=${encodeURIComponent(next)}`);
  ui.element('username').value = 'owner'; ui.element('password').value = 'test-only';
  ui.run('login.js'); await ui.element('login-form').listeners.submit(submit);
  assert.deepEqual(ui.redirects, [expected]);
});

const cows = [{ id: 1, tag_number: '105', breed: 'Jersey', status: 'lactating' },
  { id: 2, tag_number: '308', breed: 'Kiwicross', status: 'dry' }];
test('Add cow exits editing and clears the previous ID', async () => {
  const ui = harness(url => response(url === '/api/cows' ? cows : { role: 'owner' }));
  ui.run('herd.js'); await flush();
  ui.element('edit-cow-1').listeners.click(); assert.equal(ui.element('cow-edit-id').value, 1);
  ui.element('cow-add').listeners.click();
  assert.equal(ui.element('cow-edit-id').value, ''); assert.equal(ui.element('tag_number').value, '');
  assert.equal(ui.element('cow-submit').textContent, 'Add cow');
});
test('herd prevents a second in-flight save and restores the Add cow label after editing', async () => {
  let finish;
  const ui = harness((url, options) => options?.method ? new Promise(resolve => { finish = () => resolve(response({})); })
    : response(url === '/api/cows' ? cows : { role: 'owner' }));
  ui.run('herd.js'); await flush(); ui.element('edit-cow-1').listeners.click();
  const first = ui.element('cow-form').listeners.submit(submit);
  await ui.element('cow-form').listeners.submit(submit);
  assert.equal(ui.calls.filter(call => call.options?.method).length, 1);
  finish(); await first; assert.equal(ui.element('cow-submit').textContent, 'Add cow');
});
test('an older dry-off response cannot overwrite a newly selected cow’s evidence', async () => {
  const pending = new Map();
  const ui = harness(url => {
    if (url.includes('/dry-off-recommendation')) return new Promise(resolve => pending.set(url.match(/cows\/(\d+)/)[1], resolve));
    return response(url === '/api/cows' ? cows : url === '/api/auth/me' ? { role: 'owner' } : []);
  });
  ui.run('dry-off.js'); await flush();
  ui.element('review_cow').value = '1'; const first = ui.element('review_cow').listeners.change();
  ui.element('justification').value = 'Old cow notes';
  ui.element('review_cow').value = '2'; const second = ui.element('review_cow').listeners.change();
  assert.equal(ui.element('justification').value, '');
  pending.get('2')(response({ sufficient_evidence: false, evidence: { note: 'Second cow only' } })); await second;
  pending.get('1')(response({ sufficient_evidence: false, evidence: { note: 'Stale first cow' } })); await first;
  assert.match(ui.element('recommendation').innerHTML, /Second cow only/);
  assert.ok(!ui.element('recommendation').innerHTML.includes('Stale first cow'));
});
test('mobile actions stay available, default language is explicit, and the chat log has no inner scrollbar', () => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'assistant.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'public', 'assets', 'app.css'), 'utf8');
  assert.match(html, /value="en" selected/);
  assert.ok(!css.includes('.page-actions { display: none; }'));
  const chatRule = css.match(/\.chat-messages \{([^}]+)\}/)[1];
  assert.ok(!chatRule.includes('overflow-y')); assert.ok(!chatRule.includes('max-height'));
});
test('hidden feedback radio inputs are bounded instead of extending beyond a mobile viewport', () => {
  const css = fs.readFileSync(path.join(__dirname, 'public', 'assets', 'app.css'), 'utf8');
  assert.match(css, /\.rating-option \{[^}]*position: relative/);
  assert.match(css, /\.rating-option input \{[^}]*width: 1px/);
});
test('the feedback task links to the separate milking plan page', () => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'feedback.html'), 'utf8');
  assert.match(html, /href="\/schedule.html">Schedule a future change/);
});

function eventPage(rows, drugs = [], search = '', override = () => undefined) {
  return harness((url, options) => {
    const custom = override(url, options); if (custom !== undefined) return custom;
    return response(url === '/api/cows' ? [...cows, { id: 3, tag_number: '901', status: 'culled' }]
      : url === '/api/drugs' ? drugs : url === '/api/events' ? rows
      : url === '/api/auth/me' ? { role: 'owner', name: 'Owner' }
      : url === '/api/milking-schedule' ? { entries: [] } : []);
  }, search);
}
test('a predicted calving date does not mislabel a treatment-date medicine as awaiting calving', async () => {
  const ui = eventPage([{ id: 9, cow_id: 1, tag_number: '105', event_date: '2026-10-04',
    event_type: 'treatment', drug_id: 1, calculation_basis: 'treatment_date',
    calving_date_source: 'predicted', withdrawal_status: 'calculated', withdrawal_end_date: '2026-10-10' }]);
  ui.run('events.js'); await flush();
  assert.ok(!ui.element('event-list').innerHTML.includes('actual calving needed'));
  assert.ok(!ui.element('event-list').innerHTML.includes('Planning estimate'));
  assert.match(ui.element('event-list').innerHTML, /Hold through/);
});
test('correction retains a culled cow as a selectable historical reference', async () => {
  const ui = eventPage([{ id: 9, cow_id: 3, tag_number: '901', event_date: '2026-10-04', event_type: 'other' }], [], '?edit=9');
  ui.run('events.js'); await flush();
  assert.equal(ui.element('cow_id').value, 3);
  assert.ok(ui.element('cow_id').children.some(option => option.value === 3));
  assert.equal(ui.element('event-edit-id').value, 9);
});
test('correcting an inactive medicine does not silently replace it with No medicine', async () => {
  const ui = eventPage([{ id: 9, cow_id: 1, tag_number: '105', event_date: '2026-10-04', event_type: 'treatment', drug_id: 99 }], [], '?edit=9');
  ui.run('events.js'); await flush();
  assert.equal(ui.element('event-edit-id').value, '');
  assert.match(ui.element('event-result').innerHTML, /inactive medicine/);
});
test('a correction history network failure is displayed rather than left as an unhandled rejection', async () => {
  const ui = eventPage([], [], '?history=9', url => url.endsWith('/corrections') ? response({ error: 'Network unavailable' }, 500) : undefined);
  ui.run('events.js'); await flush();
  assert.match(ui.element('correction-history').innerHTML, /Unable to load correction history/);
  assert.match(ui.element('correction-history').innerHTML, /Network unavailable/);
});
test('an event saved before a history refresh failure is clearly reported as saved', async () => {
  let getCount = 0;
  const ui = eventPage([], [], '', (url, options) => {
    if (url !== '/api/events') return undefined;
    if (options?.method === 'POST') return response({ withdrawal_status: 'not_applicable', withdrawal_message: 'Recorded' });
    return ++getCount === 1 ? response([]) : response({ error: 'Temporarily unavailable' }, 503);
  });
  ui.run('events.js'); await flush();
  ui.element('cow_id').value = '1'; ui.element('event_type').value = 'other';
  await ui.element('event-form').listeners.submit(submit);
  assert.match(ui.element('event-result').innerHTML, /Saved, but history could not refresh/);
  assert.match(ui.element('event-result').innerHTML, /Do not submit again/);
});
