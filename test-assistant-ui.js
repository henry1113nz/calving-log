const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const readyStatus = {
  external_ai_available: true, configuration_message: 'Configured', provider: 'deepseek', model: 'deepseek-flash',
  can_test_connection: true, connection_test: { state: 'untested', message: 'Not tested yet' },
  limits: { used_today: 0, daily_requests: 200, per_user_per_minute: 20, day_utc: '2026-10-04' }
};

async function page(script, handler) {
  const elements = new Map();
  const calls = [];
  const notices = [];
  let start;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, checked: false, hidden: true, disabled: true, textContent: '', innerHTML: '', className: '', value: '',
      listeners: {}, dataset: {}, focus() {}, addEventListener(name, callback) { this.listeners[name] = callback; }
    });
    return elements.get(id);
  }
  const document = {
    getElementById: element,
    addEventListener(name, callback) { if (name === 'DOMContentLoaded') start = callback; }
  };
  const context = vm.createContext({ document, window: { CalvingLog: {
    badge: text => `<span>${text}</span>`, escapeHtml: value => String(value ?? '').replace(/[&<>"']/g,
      character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
    emptyState: (title, message) => `${title}: ${message}`, formatDate: value => value, humanize: value => value,
    jsonOptions: (method, body) => ({ method, body: JSON.stringify(body) }),
    requestJson: async (url, options) => { calls.push({ url, options }); return handler(url, options); },
    setBusy: (button, busy) => { button.disabled = busy; },
    showNotice: (target, message, variant) => { notices.push({ target, message, variant }); }
  } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'assets', script), 'utf8'), context);
  start();
  await new Promise(resolve => setImmediate(resolve));
  return { element, calls, notices };
}

test('AI settings opening reads configuration only and needs explicit probe consent', async () => {
  const ui = await page('ai-settings.js', () => readyStatus);
  assert.deepEqual(ui.calls.map(call => call.url), ['/api/assistant/status']);
  assert.equal(ui.element('ai-test-controls').hidden, false);
  assert.equal(ui.element('ai-test-button').disabled, true);
  ui.element('ai-test-consent').checked = true;
  ui.element('ai-test-consent').listeners.change();
  assert.equal(ui.element('ai-test-button').disabled, false);
  assert.match(ui.element('ai-connection-status').innerHTML, /Configured — not tested/);
});

test('AI settings sends one fixed consent request and disables repeated probes after success', async () => {
  let tested = false;
  const ui = await page('ai-settings.js', (url, options) => {
    if (url.endsWith('/connection-test')) {
      assert.deepEqual(JSON.parse(options.body), { consent: true });
      tested = true;
      return { state: 'connected', message: 'Connection test passed' };
    }
    return { ...readyStatus, connection_test: tested ? { state: 'connected', message: 'Test passed' } : readyStatus.connection_test };
  });
  ui.element('ai-test-consent').checked = true;
  await ui.element('ai-test-button').listeners.click();
  assert.equal(ui.calls.filter(call => call.url.endsWith('/connection-test')).length, 1);
  assert.equal(ui.element('ai-test-consent').checked, false);
  assert.equal(ui.element('ai-test-button').disabled, true);
  assert.match(ui.element('ai-connection-status').innerHTML, /Last test passed/);
  assert.equal(ui.notices.at(-1).variant, 'success');
});

test('AI settings hides paid probe controls for a non-owner', async () => {
  const ui = await page('ai-settings.js', () => ({ ...readyStatus, can_test_connection: false }));
  assert.equal(ui.element('ai-test-controls').hidden, true);
  ui.element('ai-test-consent').checked = true;
  await ui.element('ai-test-button').listeners.click();
  assert.equal(ui.calls.length, 1); assert.equal(ui.element('ai-test-button').disabled, true);
});

test('missing key keeps probe disabled and shows useful setup guidance', async () => {
  const ui = await page('ai-settings.js', () => ({ ...readyStatus, external_ai_available: false,
    configuration_message: 'Add the key in Railway Variables' }));
  ui.element('ai-test-consent').checked = true;
  ui.element('ai-test-consent').listeners.change();
  assert.equal(ui.element('ai-test-button').disabled, true);
  assert.match(ui.element('ai-connection-status').innerHTML, /Local only.*Railway Variables/s);
});

test('failed probes never display a green connected result', async () => {
  let tested = false;
  const failure = { state: 'failed', message: 'The API key was rejected' };
  const ui = await page('ai-settings.js', url => {
    if (url.endsWith('/connection-test')) { tested = true; return failure; }
    return { ...readyStatus, connection_test: tested ? failure : readyStatus.connection_test };
  });
  ui.element('ai-test-consent').checked = true;
  await ui.element('ai-test-button').listeners.click();
  assert.match(ui.element('ai-connection-status').innerHTML, /Last test failed/);
  assert.equal(ui.notices.at(-1).variant, 'warning');
});

test('Ask distinguishes configured from connected and keeps external AI opt-in', async () => {
  const ui = await page('assistant.js', () => readyStatus);
  assert.match(ui.element('assistant-status').textContent, /connection has not been tested/);
  assert.equal(ui.element('use-ai').checked, false); assert.equal(ui.element('use-ai').disabled, false);
  assert.equal(ui.element('assistant-settings-link').hidden, false);
  assert.equal(ui.calls.length, 1);
});

test('Ask displays the actual external mode even for an unsupported question', async () => {
  const ui = await page('assistant.js', (url, options) => {
    if (url.endsWith('/query')) {
      assert.equal(JSON.parse(options.body).use_ai, true);
      return { supported: false, message: 'No clinical recommendations', assistant_mode: 'external', provider: 'deepseek' };
    }
    return readyStatus;
  });
  ui.element('use-ai').checked = true;
  ui.element('assistant-question').value = 'What should I prescribe?';
  await ui.element('assistant-form').listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ui.element('assistant-result').innerHTML, /deepseek AI understood the request/);
  assert.match(ui.element('assistant-result').innerHTML, /No clinical recommendations/);
});

test('Ask rejects duplicate in-flight submissions and never reuses an old draft', async () => {
  let finish;
  const ui = await page('assistant.js', url => url.endsWith('/query')
    ? new Promise(resolve => { finish = resolve; }) : readyStatus);
  ui.element('assistant-question').value = 'A question';
  const first = ui.element('assistant-form').listeners.submit({ preventDefault() {} });
  await ui.element('assistant-form').listeners.submit({ preventDefault() {} });
  assert.equal(ui.calls.filter(call => call.url.endsWith('/query')).length, 1);
  assert.equal(ui.element('assistant-result').textContent, 'Checking your question…');
  finish({ supported: false, message: 'Nothing saved', assistant_mode: 'local' });
  await first;
  await new Promise(resolve => setImmediate(resolve));
});

test('chat opens without paid calls and uses separate opt-in for demo query results', async () => {
  const ui = await page('chat.js', () => readyStatus);
  assert.deepEqual(ui.calls.map(call => call.url), ['/api/assistant/status']);
  assert.equal(ui.element('chat-use-ai').checked, false);
  assert.equal(ui.element('chat-share-data').checked, false);
  assert.equal(ui.element('chat-share-data').disabled, true);
  ui.element('chat-use-ai').checked = true;
  await ui.element('chat-use-ai').listeners.change();
  assert.equal(ui.element('chat-share-data').disabled, false);
  assert.equal(ui.calls.length, 1);
});

test('chat sends language and consent and carries only the server conversation ID on follow-ups', async () => {
  const ui = await page('chat.js', (url, options) => {
    if (url === '/api/assistant/chat') return { reply: '有4头牛。', mode: 'external', provider: 'deepseek',
      conversation_id: 'server-issued-id', data_shared: true, sources: [] };
    return readyStatus;
  });
  ui.element('chat-use-ai').checked = true; ui.element('chat-share-data').checked = true;
  ui.element('chat-language').value = 'zh'; ui.element('chat-question').value = '多少头牛';
  await ui.element('chat-form').listeners.submit({ preventDefault() {} });
  const first = JSON.parse(ui.calls.at(-1).options.body);
  assert.equal(first.use_ai, true); assert.equal(first.share_data, true); assert.equal(first.language, 'zh');
  assert.equal(first.conversation_id, null); assert.ok(!first.history);
  ui.element('chat-question').value = '其中哪些在干奶期？';
  await ui.element('chat-form').listeners.submit({ preventDefault() {} });
  assert.equal(JSON.parse(ui.calls.at(-1).options.body).conversation_id, 'server-issued-id');
  assert.match(ui.element('chat-messages').innerHTML, /有4头牛/);
  assert.match(ui.element('chat-messages').innerHTML, /deepseek · AI response/);
});

test('chat escapes generated text/source facts and never links arbitrary model targets', async () => {
  const ui = await page('chat.js', url => url === '/api/assistant/chat' ? {
    reply: '<script>alert(1)</script>', mode: 'external', provider: 'deepseek', sources: [
      { label: '<img src=x>', href: 'javascript:alert(1)', facts: { text: '<script>bad</script>' } },
      { label: 'Herd', href: '/herd.html', facts: { active: 4 } }
    ]
  } : readyStatus);
  ui.element('chat-question').value = '<script>user</script>';
  await ui.element('chat-form').listeners.submit({ preventDefault() {} });
  const html = ui.element('chat-messages').innerHTML;
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('javascript:'));
  assert.match(html, /&lt;script&gt;/); assert.match(html, /href="\/herd.html"/);
});

test('chat blocks duplicate in-flight replies without losing a follow-up typed while waiting', async () => {
  let finish;
  const ui = await page('chat.js', url => url === '/api/assistant/chat' ? new Promise(resolve => { finish = resolve; }) : readyStatus);
  ui.element('chat-question').value = 'First question';
  const first = ui.element('chat-form').listeners.submit({ preventDefault() {} });
  await ui.element('chat-form').listeners.submit({ preventDefault() {} });
  assert.equal(ui.calls.filter(call => call.url === '/api/assistant/chat').length, 1);
  assert.equal(ui.element('chat-clear').disabled, true);
  ui.element('chat-question').value = 'Next question';
  finish({ reply: 'Answer', mode: 'local', sources: [] }); await first;
  assert.equal(ui.element('chat-question').value, 'Next question');
  assert.equal(ui.element('chat-clear').disabled, false);
});

test('new chat and withdrawal of data consent clear server context', async () => {
  const ui = await page('chat.js', url => url === '/api/assistant/chat'
    ? { reply: 'Four cows', mode: 'external', provider: 'deepseek', conversation_id: 'old-context', sources: [] }
    : url.endsWith('/clear') ? { cleared: true } : readyStatus);
  ui.element('chat-use-ai').checked = true; ui.element('chat-share-data').checked = true;
  ui.element('chat-question').value = 'Count'; await ui.element('chat-form').listeners.submit({ preventDefault() {} });
  ui.element('chat-share-data').checked = false;
  await ui.element('chat-share-data').listeners.change();
  assert.equal(ui.calls.at(-1).url, '/api/assistant/chat/clear');
  assert.equal(JSON.parse(ui.calls.at(-1).options.body).conversation_id, 'old-context');
  assert.ok(!ui.element('chat-messages').innerHTML.includes('Four cows'));
});

test('provider fallback is clearly displayed as a local lookup, not a successful AI answer', async () => {
  const ui = await page('chat.js', url => url === '/api/assistant/chat' ? {
    reply: '本地统计有4头牛。', mode: 'local', data_shared: false, notice: 'External API unavailable', sources: []
  } : readyStatus);
  ui.element('chat-use-ai').checked = true; ui.element('chat-question').value = 'Count';
  await ui.element('chat-form').listeners.submit({ preventDefault() {} });
  assert.match(ui.element('chat-messages').innerHTML, /不是 AI 对话/);
  assert.match(ui.element('chat-messages').innerHTML, /External API unavailable/);
  assert.ok(!ui.element('chat-messages').innerHTML.includes('AI response'));
});
