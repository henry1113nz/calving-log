const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyIntent, localIntent, assistantConfig } = require('./assistant');
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
