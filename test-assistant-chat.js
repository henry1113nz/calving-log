const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrate } = require('./migrate');
const { seed } = require('./seed');
const { createAssistantTools, validateArguments, KNOWLEDGE } = require('./assistantTools');
const { createConversationStore, generateChatReply, containsSecret, chatErrorCode } = require('./assistantChat');

const env = { AI_PROVIDER: 'deepseek', AI_MODEL: 'deepseek-flash', DEEPSEEK_API_KEY: 'unit-test-dummy-secret', AI_ENABLED: 'true' };
const response = (message, reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ finish_reason: reason, message: { role: 'assistant', ...message } }] }) });
const call = (name, args = {}, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function fixture() {
  const db = new Database(':memory:'); migrate(db); seed(db);
  return { db, tools: createAssistantTools({ db,
    vatExclusions: () => [{ id: 90, tag_number: '212', withdrawal_end_date: null, requires_attention: true,
      is_estimate: true, withdrawal_status: 'awaiting_calving_date', warnings: ['Actual calving date missing'], created_by: 'PRIVATE' }],
    cowStatus: tag => ({ on_hold_today: true, requires_attention: true, message: `Cow ${tag} needs review.`,
      events: [{ id: 90, withdrawal_end_date: null, requires_attention: true, notes: 'PRIVATE',
        created_by_name: 'PRIVATE', milking_schedule_snapshot: [{ effective_from: '2026-01-01', milkings_per_day: 2, note: 'PRIVATE' }] }] }) }) };
}
const base = (tools, extra = {}) => ({ question: 'How many cows? 用中文回答', role: 'owner', language: 'auto', shareData: true,
  tools, env, takeBudget: () => ({ allowed: true }), ...extra });

test('tool schemas reject SQL, unknown tools, invalid dates, extra properties and oversized paging', () => {
  assert.equal(validateArguments('run_sql', { sql: 'DELETE FROM cows' }), false);
  assert.equal(validateArguments('herd_summary', { table: 'users' }), false);
  assert.equal(validateArguments('cow_history', {}), false);
  assert.equal(validateArguments('find_cows', { offset: -1 }), false);
  assert.equal(validateArguments('find_cows', { offset: 10001 }), false);
  assert.equal(validateArguments('event_records', { from: '2026-02-30' }), false);
  assert.equal(validateArguments('event_records', { from: '2026-04-02', to: '2026-04-01' }), false);
  assert.equal(validateArguments('find_cows', { status: 'dry', offset: 0 }), true);
});

test('herd aggregate separates retained culled records from active and does not write', () => {
  const { db, tools } = fixture();
  db.prepare("INSERT INTO cows(tag_number, status) VALUES ('CULLED-TEST', 'culled')").run();
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  const result = tools.execute('herd_summary', {}, 'milker');
  assert.equal(result.data.total_including_culled, 5);
  assert.equal(result.data.active, 4);
  assert.equal(result.data.by_status.find(row => row.status === 'culled').count, 1);
  assert.equal(result.source.href, '/herd.html');
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before); db.close();
});

test('parameterised searches cannot inject SQL and SQL wildcards are literal', () => {
  const { db, tools } = fixture();
  assert.equal(tools.execute('find_cows', { search: "%' OR 1=1 --" }, 'owner').data.total, 0);
  assert.equal(tools.execute('find_cows', { search: '%' }, 'owner').data.total, 0);
  assert.equal(tools.execute('find_cows', { status: 'dry' }, 'owner').data.total, 1);
  assert.ok(tools.execute('find_cows', {}, 'owner').data.rows.every(row => !Object.hasOwn(row, 'created_at')));
  assert.deepEqual(tools.execute('herd_summary', {}, 'outsider'), { error: 'not_authorised' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cows').get().n, 4); db.close();
});

test('all tool pages are bounded with truthful full-match counts', () => {
  const { db, tools } = fixture();
  for (let i = 0; i < 25; i += 1) db.prepare('INSERT INTO cows(tag_number) VALUES (?)').run(`PAGE-${i}`);
  const first = tools.execute('find_cows', {}, 'vet').data;
  const second = tools.execute('find_cows', { offset: 20 }, 'vet').data;
  assert.equal(first.total, 29); assert.equal(first.returned, 20); assert.equal(first.truncated, true);
  assert.equal(second.total, 29); assert.equal(second.returned, 9); assert.equal(second.truncated, false);
  db.close();
});

test('stored hold tools retain uncertainty and exclude clinical notes, staff and schedule free text', () => {
  const { db, tools } = fixture();
  const hold = tools.execute('milk_holds', {}, 'milker');
  const cow = tools.execute('cow_history', { tag: '212' }, 'milker');
  assert.equal(hold.data.unresolved_records, 1);
  assert.equal(hold.data.rows[0].withdrawal_end_date, null);
  assert.equal(cow.data.requires_attention, true);
  assert.equal(cow.data.rows[0].requires_attention, true);
  assert.ok(!JSON.stringify([hold, cow]).includes('PRIVATE'));
  assert.equal(tools.execute('cow_history', { tag: 'missing' }, 'owner').data.found, false);
  db.close();
});

test('remaining query tools are read-only and omit private free-text fields', () => {
  const { db, tools } = fixture();
  const existingTests = db.prepare('SELECT COUNT(*) AS n FROM scc_records WHERE cow_id = 1').get().n;
  db.prepare("INSERT INTO scc_records(cow_id,test_date,scc_value) VALUES (1,'2026-01-01',180000)").run();
  const tag = db.prepare('SELECT tag_number FROM cows WHERE id=1').get().tag_number;
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  for (const [name, args] of [['event_records', {}], ['milking_plan', {}], ['review_queue', {}], ['scc_evidence', { tag }], ['medicine_library', {}]]) {
    const result = tools.execute(name, args, 'milker');
    assert.ok(result.source && result.data, name);
    assert.ok(!/password_hash|password_salt|created_by_name|verified_by|notes|resolution/.test(JSON.stringify(result)), name);
  }
  const scc = tools.execute('scc_evidence', { tag }, 'milker').data;
  assert.equal(scc.tests.total, existingTests + 1); assert.equal(scc.tests.rows.find(row => row.test_date === '2026-01-01').scc_value, 180000);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before); db.close();
});

test('normal multilingual replies are generated, not limited to a fixed intent response', async () => {
  const { db, tools } = fixture(); let sent;
  const result = await generateChatReply(base(tools, { fetchImpl: async (url, options) => {
    sent = JSON.parse(options.body);
    return response({ content: '数据库有4头牛，其中1头干奶。需要我继续解释吗？' });
  } }));
  assert.equal(result.mode, 'external'); assert.match(result.reply, /4头牛/);
  assert.equal(sent.thinking.type, 'disabled');
  assert.ok(!sent.response_format); assert.equal(sent.max_tokens, 1400);
  assert.ok(sent.messages.some(message => message.content.includes('total_including_culled')));
  assert.match(sent.messages[0].content, /Match the language/);
  assert.match(sent.messages[0].content, /not an intent classifier/);
  assert.equal(result.sources[0].facts.active, 4); db.close();
});

test('no data-sharing consent means no database reads, tools, overview or records sent', async () => {
  const tools = { execute() { throw new Error('No reads allowed'); }, definitions: [] }; let sent;
  const result = await generateChatReply(base(tools, { shareData: false, question: 'Explain Node.js in Spanish', fetchImpl: async (url, options) => {
    sent = JSON.parse(options.body); return response({ content: 'Node.js ejecuta JavaScript en el servidor.' });
  } }));
  assert.equal(result.data_shared, false); assert.deepEqual(result.sources, []);
  assert.equal(sent.tools, undefined); assert.equal(sent.messages.length, 2);
  assert.ok(!JSON.stringify(sent).includes('total_including_culled'));
});

test('tool loop validates arguments and grounds a follow-up in filtered database results', async () => {
  const { db, tools } = fixture(); const bodies = []; let count = 0;
  const result = await generateChatReply(base(tools, { question: '其中哪些牛在干奶期？', history: [
    { role: 'user', content: 'How many cows?' }, { role: 'assistant', content: 'There are four demo cows.' }
  ], takeBudget: () => { count += 1; return { allowed: true }; }, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    return bodies.length === 1 ? response({ content: null, tool_calls: [call('find_cows', { status: 'dry' })] }, 'tool_calls')
      : response({ content: '牛308处于干奶期。这是保存的状态，不是用药建议。' });
  } }));
  assert.equal(count, 2); assert.equal(result.tool_calls, 1);
  const data = JSON.parse(bodies[1].messages.at(-1).content);
  assert.equal(data.data.total, 1); assert.equal(data.data.rows[0].tag_number, '308');
  assert.equal(bodies[1].messages.at(-1).tool_call_id, 'call-1');
  assert.equal(result.sources.at(-1).facts.total, 1);
  assert.ok(bodies[0].messages.some(message => message.content === 'There are four demo cows.')); db.close();
});

test('multiple queries of the same tool keep both filter-specific source facts', async () => {
  const { db, tools } = fixture(); let n = 0;
  const result = await generateChatReply(base(tools, { fetchImpl: async () => ++n === 1
    ? response({ tool_calls: [call('cow_history', { tag: '212' }, 'a'), call('cow_history', { tag: '308' }, 'b')] }, 'tool_calls')
    : response({ content: 'These are two different stored histories.' }) }));
  assert.equal(result.sources.filter(source => source.tool === 'cow_history').length, 2); db.close();
});

test('malicious arbitrary SQL tools and argument injection return errors, never execute', async () => {
  const { db, tools } = fixture(); let n = 0; let sent;
  await generateChatReply(base(tools, { fetchImpl: async (url, options) => {
    sent = JSON.parse(options.body);
    return ++n === 1 ? response({ tool_calls: [call('execute_sql', { sql: 'DELETE FROM cows' }),
      call('herd_summary', { include_passwords: true }, 'call-2')] }, 'tool_calls') : response({ content: 'Those operations are unavailable.' });
  } }));
  assert.ok(sent.messages.slice(-2).every(message => JSON.parse(message.content).error === 'invalid_tool_arguments'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cows').get().n, 4); db.close();
});

test('every upstream call, including tool follow-ups, checks the shared budget', async () => {
  const { db, tools } = fixture(); let n = 0; let fetches = 0;
  await assert.rejects(generateChatReply(base(tools, { takeBudget: () => ++n === 1 ? { allowed: true } : { allowed: false, code: 'daily_limit' },
    fetchImpl: async () => { fetches += 1; return response({ tool_calls: [call('find_cows', {})] }, 'tool_calls'); } })), error => error.aiCode === 'daily_limit');
  assert.equal(fetches, 1); db.close();
});

test('tool loops are bounded and cannot continue requesting unlimited tools', async () => {
  const { db, tools } = fixture(); let n = 0;
  await assert.rejects(generateChatReply(base(tools, { fetchImpl: async () => {
    n += 1; return response({ tool_calls: [call('find_cows', {})] }, 'tool_calls');
  } })), error => error.aiCode === 'tool_limit');
  assert.equal(n, 5); db.close();
});

test('truncated, malformed or empty completions are rejected, never shown as successful AI', async () => {
  const { db, tools } = fixture();
  for (const [message, reason] of [[{ content: 'partial' }, 'length'], [{ content: '' }, 'stop'],
    [{ tool_calls: [call('find_cows')] }, 'stop'], [{ tool_calls: [call('find_cows', {}, 'same'), call('find_cows', {}, 'same')] }, 'tool_calls']]) {
    await assert.rejects(generateChatReply(base(tools, { fetchImpl: async () => response(message, reason) })), error => ['invalid_response', 'tool_limit'].includes(error.aiCode));
  }
  db.close();
});

test('upstream error bodies are not disclosed and failed calls use safe error codes', async () => {
  const { db, tools } = fixture();
  for (const [status, code] of [[401, 'authentication_failed'], [402, 'insufficient_balance'], [429, 'provider_rate_limit'], [500, 'provider_unavailable']]) {
    await assert.rejects(generateChatReply(base(tools, { fetchImpl: async () => ({ ok: false, status,
      json() { throw new Error('PRIVATE provider body should never be read'); } }) })), error => error.aiCode === code && !error.message.includes('PRIVATE'));
  }
  assert.equal(chatErrorCode(Object.assign(new Error('private'), { name: 'TimeoutError' })), 'timeout'); db.close();
});

test('likely pasted credentials are blocked before any paid call or database read', async () => {
  assert.equal(containsSecret('What is an API key?'), false);
  assert.equal(containsSecret('password: private-test-only'), true);
  assert.equal(containsSecret('sk-unit-test-key-not-a-real-key'), true);
  let calls = 0;
  await assert.rejects(generateChatReply(base({}, { question: 'password: private-test-only',
    fetchImpl: async () => { calls += 1; } })), error => error.aiCode === 'sensitive_input');
  assert.equal(calls, 0);
});

test('business context explains real roles and technology without claiming internet access', () => {
  assert.match(KNOWLEDGE, /SQLite\/better-sqlite3/);
  assert.match(KNOWLEDGE, /Only Owner changes it/);
  assert.match(KNOWLEDGE, /Milker reads only/);
  assert.match(KNOWLEDGE, /all applicable conditions must be met/);
  assert.match(KNOWLEDGE, /no internet search/i);
});

test('conversation memory is session-scoped, bounded, expires and clears explicitly', () => {
  let time = 1000; const store = createConversationStore({ now: () => time });
  const item = store.open(null, 'owner-session', true);
  assert.throws(() => store.open(item.id, 'other-session', true), /conversation_not_found/);
  assert.throws(() => store.open(item.id, 'owner-session', true), /conversation_busy/);
  for (let i = 0; i < 20; i += 1) store.finish(item, `Question ${i}`, `Answer ${i}`);
  assert.equal(item.messages.length, 16);
  assert.equal(store.clear(item.id, 'other-session'), false);
  time += 31 * 60 * 1000;
  assert.throws(() => store.open(item.id, 'owner-session', true), /conversation_not_found/);
  const fresh = store.open(null, 'owner-session', false); store.finish(fresh);
  assert.equal(store.clear(fresh.id, 'owner-session'), true);
});

test('withdrawal of data sharing removes earlier record facts from follow-up context', () => {
  const store = createConversationStore(); const first = store.open(null, 'same-session', true);
  store.finish(first, 'How many?', 'There are four stored cows.');
  const next = store.open(first.id, 'same-session', false);
  assert.deepEqual(next.messages, []); assert.equal(next.shareData, false); store.finish(next);
});
