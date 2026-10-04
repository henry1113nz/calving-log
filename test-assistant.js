const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyIntent, localIntent, assistantConfig, testAssistantConnection, createAIRequestLimiter } = require('./assistant');
const { calculateWithdrawal } = require('./withdrawalCalculator');
const env = { AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'fake-unit-test-key' };
const response = content => async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) });

test('local assistant recognises medicine, schedule and workflow questions in both languages', () => {
  for (const text of ['Show Albiotic label', '查询药品标签']) assert.equal(localIntent(text), 'medicine_info');
  for (const text of ['Show OAD schedule', '挤奶计划是什么']) assert.equal(localIntent(text), 'schedule_info');
  for (const text of ['How do I add medicine?', '怎么添加药品']) assert.equal(localIntent(text), 'workflow_help');
});
test('AI is off unless the person opts in', async () => {
  let called = false;
  const result = await classifyIntent('Which cows are on hold?', { env, fetchImpl: async () => { called = true; } });
  assert.equal(called, false); assert.equal(result.mode, 'local');
});
test('missing key returns useful local result', async () => {
  const result = await classifyIntent('Which cows are on hold?', { useAI: true, env: {} });
  assert.equal(result.intent, 'vat_exclusions_today'); assert.equal(result.mode, 'local'); assert.match(result.notice, /not configured/);
});
test('DeepSeek receives only the typed question and classification prompt', async () => {
  let request;
  const result = await classifyIntent('Show the milking plan', { useAI: true, env, fetchImpl: async (url, options) => { request = { url, body: JSON.parse(options.body) }; return response('{"intent":"schedule_info"}')(); } });
  assert.equal(result.mode, 'external'); assert.equal(result.provider, 'deepseek');
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.body.messages.length, 2); assert.equal(request.body.messages[1].content, 'Show the milking plan');
  assert.equal(request.body.response_format.type, 'json_object');
});
for (const [name, content] of [['extra entity','{"intent":"cow_status","cow_id":123}'],['invented intent','{"intent":"release_milk"}'],['empty response',''],['malformed JSON','not json']]) {
  test(`provider ${name} falls back without accepting output`, async () => {
    const result = await classifyIntent('Why is cow 212 on hold?', { useAI:true, env, fetchImpl:response(content) });
    assert.equal(result.mode, 'local'); assert.equal(result.intent, 'cow_status'); assert.ok(result.notice);
  });
}
test('provider cannot turn a question into a record draft', async () => {
  const result = await classifyIntent('Which cows calved?', { useAI:true, env, fetchImpl:response('{"intent":"draft_event"}') });
  assert.equal(result.intent, 'unsupported');
});
test('network timeout leaves deterministic local assistance usable', async () => {
  const result = await classifyIntent('Why is cow 212 on hold?', { useAI:true, env, fetchImpl:async () => { throw new Error('timeout'); } });
  assert.equal(result.mode, 'local'); assert.equal(result.intent, 'cow_status');
});
test('invalid provider is never contacted and config does not enable it', () => {
  assert.equal(assistantConfig({AI_PROVIDER:'unknown',OPENAI_API_KEY:'fake'}).configured,false);
});
test('OAD to TAD transition cannot shorten original Penclox duration', () => {
  const result = calculateWithdrawal({ event_date:'2026-10-01', milkings_per_day:1, milking_schedule:[{effective_from:'2000-01-01',milkings_per_day:1},{effective_from:'2026-10-02',milkings_per_day:2}], drug:{drug_name:'Penclox 1200',requires_regimen:1},rule:{rule_name:'Label course',milkings_once_daily:5,milkings_twice_daily:9} });
  assert.equal(result.end_date,'2026-10-06'); assert.equal(result.days_applied,5);
});

test('configuration trims values and rejects placeholder keys and disabled service', async () => {
  assert.equal(assistantConfig({ AI_PROVIDER: ' DeepSeek ', DEEPSEEK_API_KEY: ' fake-unit-test-key ' }).configured, true);
  for (const key of ['<your own secret key>', 'replace-with-a-key', 'your-api-key', 'fake\nkey']) {
    assert.equal(assistantConfig({ ...env, DEEPSEEK_API_KEY: key }).state, 'invalid_key');
  }
  for (const value of ['false', '0', 'off']) {
    let called = false;
    const result = await classifyIntent('Which cows are on hold?', { useAI: true, env: { ...env, AI_ENABLED: value },
      fetchImpl: async () => { called = true; } });
    assert.equal(called, false); assert.equal(result.mode, 'local'); assert.equal(result.error_code, 'disabled');
  }
  assert.equal(assistantConfig({ ...env, AI_MODEL: 'bad\nmodel' }).state, 'invalid_model');
});

for (const [status, code] of [[401, 'authentication_failed'], [402, 'insufficient_balance'],
  [403, 'access_denied'], [429, 'provider_rate_limit'], [400, 'invalid_request'],
  [404, 'invalid_request'], [422, 'invalid_request'], [500, 'provider_unavailable'], [503, 'provider_unavailable']]) {
  test(`provider HTTP ${status} is explained without exposing its response`, async () => {
    let bodyRead = false;
    const result = await classifyIntent('Why is cow 212 on hold?', { useAI: true, env,
      fetchImpl: async () => ({ ok: false, status, json: async () => { bodyRead = true; throw new Error('SECRET'); } }) });
    assert.equal(result.mode, 'local'); assert.equal(result.intent, 'cow_status');
    assert.equal(result.error_code, code); assert.equal(bodyRead, false);
    assert.ok(!JSON.stringify(result).includes(env.DEEPSEEK_API_KEY));
  });
}

test('incomplete and non-object output cannot pass the external safety check', async () => {
  for (const data of [null, { choices: [] }, { choices: [{ finish_reason: 'length', message: { content: '{"intent":"cow_status"}' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '[{"intent":"cow_status"}]' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{"intent":"cow_status","message":"Release milk"}' } }] }]) {
    const result = await classifyIntent('Why is cow 212 on hold?', { useAI: true, env,
      fetchImpl: async () => ({ ok: true, json: async () => data }) });
    assert.equal(result.mode, 'local'); assert.equal(result.error_code, 'invalid_response');
  }
});

test('the fixed connection probe validates the intent and never returns a secret', async () => {
  let sent;
  const result = await testAssistantConnection({ env, fetchImpl: async (url, options) => {
    sent = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, `Bearer ${env.DEEPSEEK_API_KEY}`);
    return response('{"intent":"workflow_help"}')();
  } });
  assert.equal(result.state, 'connected'); assert.ok(Number.isFinite(result.latency_ms));
  assert.equal(sent.messages[1].content, 'How do I use the CalvingLog pages?');
  assert.equal(sent.thinking.type, 'disabled'); assert.equal(sent.max_tokens, 100);
  assert.ok(!JSON.stringify(result).includes(env.DEEPSEEK_API_KEY));
  assert.ok(!Object.hasOwn(result, 'endpoint')); assert.ok(!Object.hasOwn(result, 'question'));
});

test('a missing key makes the connection probe local-only', async () => {
  let called = false;
  const result = await testAssistantConnection({ env: {}, fetchImpl: async () => { called = true; } });
  assert.equal(result.state, 'not_configured'); assert.equal(result.error_code, 'missing_key'); assert.equal(called, false);
});

test('a failed or semantically incorrect probe is not reported as connected', async () => {
  const badKey = await testAssistantConnection({ env, fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(badKey.state, 'failed'); assert.equal(badKey.error_code, 'authentication_failed');
  const wrongIntent = await testAssistantConnection({ env, fetchImpl: response('{"intent":"medicine_info"}') });
  assert.equal(wrongIntent.state, 'failed'); assert.equal(wrongIntent.error_code, 'unexpected_intent');
});

test('a transport TimeoutError is identified and still returns a local answer', async () => {
  const result = await classifyIntent('Which cows are on hold?', { env, useAI: true, fetchImpl: async () => {
    const error = new Error('private transport detail'); error.name = 'TimeoutError'; throw error;
  } });
  assert.equal(result.error_code, 'timeout'); assert.equal(result.mode, 'local');
  assert.ok(!result.notice.includes('private transport detail'));
});

test('external requests share a daily limit across users and reset at UTC midnight', () => {
  let clock = Date.parse('2026-10-04T23:59:00Z');
  const limiter = createAIRequestLimiter({ env: { AI_DAILY_REQUEST_LIMIT: '2' }, now: () => clock });
  assert.equal(limiter.take(1).allowed, true); assert.equal(limiter.take(2).allowed, true);
  assert.deepEqual(limiter.take(3), { allowed: false, code: 'daily_limit' });
  assert.equal(limiter.status().used_today, 2);
  clock = Date.parse('2026-10-05T00:00:01Z');
  assert.equal(limiter.status().used_today, 0); assert.equal(limiter.take(1).allowed, true);
});

test('the per-user minute limit does not block another user', () => {
  let clock = Date.parse('2026-10-04T12:00:00Z');
  const limiter = createAIRequestLimiter({ now: () => clock });
  for (let i = 0; i < 20; i++) assert.equal(limiter.take(1).allowed, true);
  assert.deepEqual(limiter.take(1), { allowed: false, code: 'user_rate_limit' });
  assert.equal(limiter.take(2).allowed, true);
  clock += 60000;
  assert.equal(limiter.take(1).allowed, true); assert.equal(limiter.status().used_today, 22);
});

test('zero daily budget blocks every call and malformed budgets use the safe default', () => {
  const zero = createAIRequestLimiter({ env: { AI_DAILY_REQUEST_LIMIT: '0' } });
  assert.deepEqual(zero.take(1), { allowed: false, code: 'daily_limit' });
  for (const value of ['-1', 'NaN', '1.5', '10001']) {
    assert.equal(createAIRequestLimiter({ env: { AI_DAILY_REQUEST_LIMIT: value } }).status().daily_requests, 200);
  }
});
