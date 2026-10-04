// End-to-end HTTP + real temporary SQLite + mocked provider. No API credit or live farm data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('conversational HTTP workflow: consent, records, follow-ups, isolation, fallback and no writes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calving-chat-test-'));
  const base = 'http://127.0.0.1:3998';
  const observed = [];
  const code = `
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      const users = body.messages.filter(message => message.role === 'user');
      const question = users.at(-1).content;
      const last = body.messages.at(-1);
      const overviewMessage = body.messages.find(message => message.role === 'system' && message.content.startsWith('Fresh demo herd overview'));
      const overview = overviewMessage ? JSON.parse(overviewMessage.content.split(': ').slice(1).join(': ')) : null;
      console.log('CHAT_TEST_REQUEST:' + JSON.stringify({ question, userTurns: users.length,
        hasOverview: Boolean(overview), hasTools: Boolean(body.tools), toolMessage: last.role === 'tool',
        privateFields: /password_hash|password_salt|created_by_name|verified_by|created_by":|token_hash/.test(JSON.stringify(body)) }));
      if (question === 'Wait') await new Promise(resolve => setTimeout(resolve, 150));
      if (question === 'Provider fails') return { ok: false, status: 402 };
      let message;
      if (question === '其中哪些在干奶期？' && last.role === 'user') {
        message = { role: 'assistant', content: null, tool_calls: [{ id: 'test-call', type: 'function',
          function: { name: 'find_cows', arguments: JSON.stringify({ status: 'dry' }) } }] };
      } else if (last.role === 'tool') {
        const data = JSON.parse(last.content).data;
        message = { role: 'assistant', content: '干奶牛：' + data.rows.map(row => row.tag_number).join(', ') + '；连续追问轮数：' + users.length };
      } else {
        message = { role: 'assistant', content: overview ? '数据库共 ' + overview.total_including_culled + ' 头牛。' : 'No database results were provided.' };
      }
      return { ok: true, json: async () => ({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] }) };
    };
    require('./server');
  `;
  const child = spawn(process.execPath, ['-e', code], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', PORT: '3998', CALVING_LOG_DB: path.join(directory, 'test.db'),
      AI_ENABLED: 'true', AI_PROVIDER: 'deepseek', AI_MODEL: 'deepseek-flash',
      DEEPSEEK_API_KEY: 'unit-test-dummy-secret', OPENAI_API_KEY: '', AI_DAILY_REQUEST_LIMIT: '200',
      CALVING_LOG_OWNER_PASSWORD: 'calving-owner-2026', CALVING_LOG_VET_PASSWORD: 'calving-vet-2026',
      CALVING_LOG_MILKER_PASSWORD: 'calving-milker-2026' } });
  let pending = ''; let stderr = '';
  child.stdout.on('data', chunk => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
      if (line.startsWith('CHAT_TEST_REQUEST:')) observed.push(JSON.parse(line.slice('CHAT_TEST_REQUEST:'.length)));
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  async function call(route, body, cookie = '', method = 'POST') {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      try { ready = (await fetch(base + '/api/health')).ok; if (ready) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, stderr);
    const owner = (await call('/api/auth/login', { username: 'owner', password: 'calving-owner-2026' })).cookie;
    const secondOwner = (await call('/api/auth/login', { username: 'owner', password: 'calving-owner-2026' })).cookie;
    const milker = (await call('/api/auth/login', { username: 'milker', password: 'calving-milker-2026' })).cookie;
    const eventsBefore = (await call('/api/events', null, owner, 'GET')).body;
    const cowsBefore = (await call('/api/cows', null, owner, 'GET')).body;

    const local = await call('/api/assistant/chat', { question: 'How many cows?' }, owner);
    assert.equal(local.body.mode, 'local'); assert.equal(observed.length, 0);
    const privateChat = await call('/api/assistant/chat', { question: 'Explain Node.js', use_ai: true }, owner);
    assert.equal(privateChat.body.mode, 'external'); assert.equal(privateChat.body.data_shared, false);
    assert.equal(observed.at(-1).hasTools, false); assert.equal(observed.at(-1).hasOverview, false);

    const first = await call('/api/assistant/chat', { question: '多少头牛？', use_ai: true, share_data: true, language: 'zh' }, owner);
    assert.equal(first.body.mode, 'external'); assert.match(first.body.reply, /4 头牛/);
    assert.equal(first.body.sources[0].facts.active, 4); assert.equal(first.body.read_only, true);
    const id = first.body.conversation_id;
    const follow = await call('/api/assistant/chat', { question: '其中哪些在干奶期？', use_ai: true,
      share_data: true, conversation_id: id }, owner);
    assert.match(follow.body.reply, /308/); assert.match(follow.body.reply, /轮数：2/);
    assert.equal(follow.body.tool_calls, 1); assert.equal(follow.body.sources.at(-1).facts.total, 1);

    const foreign = await call('/api/assistant/chat', { question: 'Read their chat', use_ai: true, share_data: true, conversation_id: id }, secondOwner);
    assert.equal(foreign.status, 409);
    const clearedByOther = await call('/api/assistant/chat/clear', { conversation_id: id }, secondOwner);
    assert.equal(clearedByOther.body.cleared, false);
    const withdrawn = await call('/api/assistant/chat', { question: 'Explain TAD', use_ai: true,
      share_data: false, conversation_id: id }, owner);
    assert.equal(withdrawn.body.data_shared, false); assert.equal(observed.at(-1).userTurns, 1);
    assert.equal(observed.at(-1).hasTools, false); assert.equal(observed.at(-1).hasOverview, false);

    const milkerCount = await call('/api/assistant/chat', { question: '多少头牛？', use_ai: true, share_data: true }, milker);
    assert.equal(milkerCount.body.mode, 'external'); assert.match(milkerCount.body.reply, /4 头牛/);
    assert.ok(observed.every(item => !item.privateFields));
    const beforeSecret = observed.length;
    const secret = await call('/api/assistant/chat', { question: 'password: unit-test-only', use_ai: true, share_data: true }, milker);
    assert.equal(secret.status, 400); assert.equal(observed.length, beforeSecret);

    const failed = await call('/api/assistant/chat', { question: 'Provider fails', use_ai: true, share_data: true }, milker);
    assert.equal(failed.body.mode, 'local'); assert.equal(failed.body.error_code, 'insufficient_balance');
    assert.equal(failed.body.data_shared, true); // Request context was sent even though generation failed.
    assert.ok(failed.body.notice); assert.equal(failed.body.read_only, true);
    const waiting = call('/api/assistant/chat', { question: 'Wait', use_ai: true }, owner);
    await new Promise(resolve => setTimeout(resolve, 25));
    const concurrent = await call('/api/assistant/chat', { question: 'Another', use_ai: true }, secondOwner);
    assert.equal(concurrent.status, 409); await waiting;

    const clear = await call('/api/assistant/chat/clear', { conversation_id: milkerCount.body.conversation_id }, milker);
    assert.equal(clear.body.cleared, false); // Starting a newer chat has already expired the older memory.
    assert.deepEqual((await call('/api/events', null, owner, 'GET')).body, eventsBefore);
    assert.deepEqual((await call('/api/cows', null, owner, 'GET')).body, cowsBefore);
    const status = await call('/api/assistant/status', null, owner, 'GET');
    assert.equal(status.body.limits.used_today, observed.length);
    assert.ok(!JSON.stringify(status.body).includes('unit-test-dummy-secret'));
  } finally {
    const closed = new Promise(resolve => child.once('exit', resolve));
    child.kill(); await closed;
    // Exact directory generated by this test; no user files or workspace directories.
    assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(directory).startsWith('calving-chat-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
