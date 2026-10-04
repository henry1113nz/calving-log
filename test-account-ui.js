const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const users = [{ id: 1, name: 'Owner', username: 'owner', role: 'owner', is_active: 1, created_at: '2026-10-04' },
  { id: 2, name: '<script>Example</script>', username: 'trial', role: 'milker', is_active: 0, created_at: '2026-10-04' }];
const flush = () => new Promise(resolve => setImmediate(resolve));
async function page(role = 'owner', write) {
  const elements = new Map(), calls = [], notices = [];
  let ready;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: true, disabled: false, checked: false,
      innerHTML: '', textContent: '', className: '', listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      reset() { for (const name of ['access-owner-password', 'access-temporary-password', 'access-reason', 'access-user']) element(name).value = ''; element('access-action').value = 'disable'; }
    });
    return elements.get(id);
  };
  const context = vm.createContext({ document: { getElementById: element, addEventListener(name, callback) { ready = callback; } },
    window: { CalvingLog: {
      badge: text => `<span>${text}</span>`, emptyState: title => title,
      escapeHtml: value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      formatDate: value => value, formatTimestamp: value => value, humanize: value => value,
      jsonOptions: (method, body) => ({ method, body: JSON.stringify(body) }),
      requestJson: async (url, options) => {
        calls.push({ url, options });
        if (options) return write?.(url, options) || { message: 'Updated' };
        return url === '/api/auth/me' ? { ...users[0], role } : url === '/api/users' ? users : [];
      },
      setBusy: (button, busy) => { button.disabled = busy; },
      showNotice: (target, message, variant) => notices.push({ target, message, variant })
    } }
  });
  vm.runInContext(fs.readFileSync('public/assets/account.js', 'utf8'), context);
  await ready(); await flush();
  return { element, calls, notices };
}
test('owner can see retained account status without passwords or unsafe names', async () => {
  const ui = await page();
  assert.equal(ui.element('people-card').hidden, false);
  assert.match(ui.element('people-list').innerHTML, /Disabled/);
  assert.ok(!ui.element('people-list').innerHTML.includes('<script>'));
  assert.ok(!ui.element('access-user').innerHTML.includes('value="1"'));
  assert.match(ui.element('access-user').innerHTML, /value="2"/);
});
for (const role of ['vet', 'milker']) test(`${role} never loads or reveals owner account controls`, async () => {
  const ui = await page(role);
  assert.deepEqual(ui.calls.map(call => call.url), ['/api/auth/me']);
  assert.equal(ui.element('people-card').hidden, true);
});
test('temporary password is required only for reset and is cleared when changing action', async () => {
  const ui = await page();
  ui.element('access-action').value = 'reset_password';
  ui.element('access-action').listeners.change();
  assert.equal(ui.element('access-temporary-field').hidden, false);
  assert.equal(ui.element('access-temporary-password').required, true);
  ui.element('access-temporary-password').value = 'a-local-test-password';
  ui.element('access-action').value = 'disable';
  ui.element('access-action').listeners.change();
  assert.equal(ui.element('access-temporary-field').hidden, true);
  assert.equal(ui.element('access-temporary-password').value, '');
});
test('account actions block duplicate saves, clear passwords after success and reload status', async () => {
  let finish;
  const ui = await page('owner', () => new Promise(resolve => { finish = resolve; }));
  ui.element('access-user').value = '2'; ui.element('access-action').value = 'disable';
  ui.element('access-owner-password').value = 'local-owner-test-password'; ui.element('access-reason').value = 'Trial completed';
  const submit = () => ui.element('access-form').listeners.submit({ preventDefault() {}, currentTarget: ui.element('access-form') });
  const first = submit(); await submit();
  const writes = ui.calls.filter(call => call.options);
  assert.equal(writes.length, 1); assert.equal(writes[0].url, '/api/users/2/access');
  assert.deepEqual(JSON.parse(writes[0].options.body), { action: 'disable', current_password: 'local-owner-test-password', temporary_password: '', reason: 'Trial completed' });
  finish({ message: 'Account disabled' }); await first;
  assert.equal(ui.element('access-owner-password').value, '');
  assert.equal(ui.element('access-submit').disabled, false);
  assert.equal(ui.notices.at(-1).variant, 'success');
  assert.equal(ui.calls.filter(call => call.url === '/api/account-actions').length, 2);
});
test('failed account changes stay visible and do not report a save', async () => {
  const ui = await page('owner', () => { throw new Error('Owner password is incorrect'); });
  ui.element('access-user').value = '2';
  await ui.element('access-form').listeners.submit({ preventDefault() {}, currentTarget: ui.element('access-form') });
  assert.equal(ui.notices.at(-1).variant, 'error');
  assert.match(ui.notices.at(-1).message, /incorrect/);
  assert.equal(ui.element('access-submit').disabled, false);
});
