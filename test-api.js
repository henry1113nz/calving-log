#!/usr/bin/env node
//
// 接口测试。
//
//   node test-api.js
//
// 在一个临时数据库上起一份服务,跑完一整套请求再把它删掉,所以可以随时重复
// 执行,不会污染开发用的数据。覆盖正常路径,以及必填校验、外键校验、404、
// 枚举约束这些边界情况——对应项目文档 14.1 节列出的测试类型。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = path.join(os.tmpdir(), `calving-log-test-${process.pid}.db`);

const green = s => `\x1b[32m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const dim = s => `\x1b[90m${s}\x1b[0m`;
const bold = s => `\x1b[1m${s}\x1b[0m`;

let passed = 0;
let failed = 0;
let sessionCookie = '';

function heading(text) {
  console.log(`\n${bold(text)}\n${'-'.repeat(text.length)}`);
}

function assert(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ${green('PASS')}  ${label}`);
  } else {
    failed += 1;
    console.log(`  ${red('FAIL')}  ${label}${detail ? '\n        ' + detail : ''}`);
  }
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().split('T')[0];
}

async function call(method, url, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (sessionCookie) headers.Cookie = sessionCookie;
  const response = await fetch(BASE + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 204 等无内容响应 */ }
  return { status: response.status, body: json, setCookie: response.headers.get('set-cookie') };
}

async function login(username, password) {
  sessionCookie = '';
  const response = await call('POST', '/api/auth/login', { username, password });
  if (response.setCookie) sessionCookie = response.setCookie.split(';')[0];
  return response;
}

async function waitForServer(attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fetch(BASE + '/api/health');
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  return false;
}

async function run() {
  console.log(bold('\nCalvingLog API tests'));
  console.log(dim(`temporary database: ${TEST_DB}`));

  // ------------------------------------------------------- authentication
  heading('Authentication and session identity');

  let res = await call('GET', '/api/cows');
  assert('protected APIs reject an unauthenticated request', res.status === 401);

  res = await login('owner', 'incorrect-password');
  assert('login rejects an incorrect password', res.status === 401 && !sessionCookie);

  res = await login('owner', 'calving-owner-2026');
  const owner = res.body;
  assert('the seeded owner can sign in and receives a session cookie',
    res.status === 200 && owner.role === 'owner' && Boolean(sessionCookie), JSON.stringify(res.body));

  res = await call('GET', '/api/auth/me');
  assert('GET /api/auth/me returns the server-side session identity',
    res.status === 200 && res.body.id === owner.id && res.body.username === 'owner',
    JSON.stringify(res.body));

  res = await call('POST', '/api/auth/change-password', {
    current_password: 'wrong-current-password', new_password: 'owner-new-password-2026'
  });
  assert('password change rejects an incorrect current password', res.status === 400);

  res = await call('POST', '/api/auth/change-password', {
    current_password: 'calving-owner-2026', new_password: 'too-short'
  });
  assert('password change requires at least twelve characters', res.status === 400);

  res = await call('POST', '/api/auth/change-password', {
    current_password: 'calving-owner-2026', new_password: 'owner-new-password-2026'
  });
  if (res.setCookie) sessionCookie = res.setCookie.split(';')[0];
  assert('a signed-in user can change their own password and keep a renewed session',
    res.status === 200 && /other signed-in sessions/i.test(res.body.message) && Boolean(res.setCookie),
    JSON.stringify(res.body));

  res = await login('owner', 'calving-owner-2026');
  assert('the previous password stops working after a change', res.status === 401);

  res = await login('owner', 'owner-new-password-2026');
  assert('the new password works', res.status === 200 && res.body.role === 'owner');

  res = await call('POST', '/api/auth/change-password', {
    current_password: 'owner-new-password-2026', new_password: 'calving-owner-2026'
  });
  if (res.setCookie) sessionCookie = res.setCookie.split(';')[0];
  assert('the test restores the development owner password', res.status === 200 && Boolean(res.setCookie));

  // ------------------------------------------------------------------- cows
  heading('Cows');

  res = await call('GET', '/api/cows');
  assert('GET /api/cows returns the seeded herd', res.status === 200 && res.body.length === 4,
    `status=${res.status} count=${res.body && res.body.length}`);

  res = await call('POST', '/api/cows', { tag_number: '555', breed: 'Jersey', lactation_number: 2 });
  const newCowId = res.body && res.body.id;
  assert('POST /api/cows creates a cow', res.status === 201 && res.body.tag_number === '555',
    JSON.stringify(res.body));

  res = await call('POST', '/api/cows', { breed: 'Jersey' });
  assert('POST /api/cows without a tag number is rejected', res.status === 400);

  res = await call('POST', '/api/cows', { tag_number: '555' });
  assert('POST /api/cows with a duplicate tag number is rejected', res.status >= 400,
    `status=${res.status}`);

  res = await call('PUT', `/api/cows/${newCowId}`, { status: 'dry' });
  assert('PUT /api/cows/:id updates only the given field',
    res.status === 200 && res.body.status === 'dry' && res.body.breed === 'Jersey',
    JSON.stringify(res.body));

  res = await call('PUT', '/api/cows/99999', { status: 'dry' });
  assert('PUT /api/cows/:id on an unknown cow returns 404', res.status === 404);

  res = await call('PUT', `/api/cows/${newCowId}`, { tag_number: '212' });
  assert('PUT /api/cows/:id cannot steal another cow\'s tag number', res.status === 400);

  // ----------------------------------------------------------------- events
  heading('Health events and the withholding snapshot');

  const drugResponse = await call('GET', '/api/drugs');
  const drugs = drugResponse.body;
  assert('GET /api/drugs exposes the five active, verified references',
    drugResponse.status === 200 && Array.isArray(drugs) && drugs.length === 5
      && drugs.every(d => d.is_active === 1 && d.is_verified === true),
    JSON.stringify(drugs));
  assert('GET /api/drugs always exposes a rules array',
    drugs.every(d => Array.isArray(d.rules)),
    JSON.stringify(drugs.map(d => ({ name: d.drug_name, rules: d.rules }))));

  const mastalone = drugs.find(d => d.drug_name === 'Mastalone');
  const penethaject = drugs.find(d => d.drug_name === 'Penethaject');
  const orbenin = drugs.find(d => d.drug_name === 'Orbenin L.A.');
  const dryCowDrug = drugs.find(d => d.drug_name === 'Cepravin Dry Cow');
  const teatSeal = drugs.find(d => /^teat\s*seal$/i.test(d.drug_name));
  const lactatingDrug = mastalone;
  const lactatingRule = lactatingDrug;
  const dryCowRule = dryCowDrug;

  assert('the five expected active products are present',
    [mastalone, penethaject, orbenin, dryCowDrug, teatSeal].every(Boolean),
    JSON.stringify(drugs.map(d => d.drug_name)));

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'treatment', event_date: '2026-08-01',
    drug_id: lactatingDrug.id, diagnosis: 'clinical_mastitis', notes: 'test treatment'
  });
  const treatmentId = res.body && res.body.id;
  const lactatingDays = Math.ceil(
    lactatingRule.milk_withdrawal_value /
      (lactatingRule.milk_withdrawal_unit === 'hours' ? 24 :
        lactatingRule.milk_withdrawal_unit === 'milkings' ? 2 : 1)
  );
  const expectedEnd = addDays('2026-08-01', lactatingDays);
  assert('lactating-cow drug counts from the treatment date',
    res.status === 201 && res.body.withdrawal_end_date === expectedEnd,
    `expected ${expectedEnd}, got ${res.body && res.body.withdrawal_end_date}`);
  assert('the event freezes its reference revision without inventing a regimen rule',
    Number.isInteger(res.body.drug_reference_revision_id)
      && Object.hasOwn(res.body, 'drug_rule_id') && res.body.drug_rule_id === null,
    JSON.stringify(res.body));

  // 干奶药按产犊后的挤奶次数算,治疗到产犊要满足标签的最小干奶期。
  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'dry_off', event_date: '2026-05-10',
    calving_date: '2026-08-20', drug_id: dryCowDrug.id
  });
  const dryOffId = res.body && res.body.id;
  const settings = (await call('GET', '/api/settings')).body;
  const dryCowDays = Math.ceil(dryCowRule.milk_withdrawal_value / settings.milkings_per_day);
  const expectedDryEnd = addDays('2026-08-20', dryCowDays);
  assert('dry-cow drug counts from the calving date, not the treatment date',
    res.status === 201 && res.body.withdrawal_end_date === expectedDryEnd,
    `expected ${expectedDryEnd}, got ${res.body && res.body.withdrawal_end_date}`);
  assert('a calving date entered at dry-off is recorded as an estimate, not a fact',
    res.body.calving_date_source === 'predicted',
    `got ${res.body && res.body.calving_date_source}`);

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'dry_off', event_date: '2026-05-11', drug_id: dryCowDrug.id
  });
  const awaitingEventId = res.body && res.body.id;
  assert('dry-cow drug with no calving date yields no withholding date rather than a wrong one',
    res.status === 201 && res.body.withdrawal_end_date === null
      && res.body.withdrawal_status === 'awaiting_calving_date',
    `got ${res.body && res.body.withdrawal_status}`);

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'treatment', event_date: '2026-08-01', drug_id: orbenin.id
  });
  assert('Orbenin refuses to guess when its regimen was not selected',
    res.status === 400 && /regimen|rule/i.test(res.body && res.body.error),
    `status=${res.status} body=${JSON.stringify(res.body)}`);

  const orbeninRule = orbenin.rules[0];
  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'treatment', event_date: '2026-08-01',
    drug_id: orbenin.id, drug_rule_id: orbeninRule.id
  });
  const expectedOrbeninEnd = addDays(
    '2026-08-01', Math.ceil(orbeninRule.milkings_twice_daily / 2)
  );
  assert('Orbenin calculates only after an explicit regimen is selected',
    res.status === 201 && res.body.drug_rule_id === orbeninRule.id
      && res.body.withdrawal_end_date === expectedOrbeninEnd,
    JSON.stringify(res.body));

  // ---------------------------------------------- milkings and milking frequency
  heading('Milkings, milking frequency and the minimum dry period');

  assert('the dry-cow drug is expressed in milkings, not days',
    dryCowRule.milk_withdrawal_unit === 'milkings',
    `unit is ${dryCowRule.milk_withdrawal_unit}`);

  await call('PUT', '/api/settings', { milkings_per_day: 1 });
  const oadCow = (await call('POST', '/api/cows', { tag_number: '601', lactation_number: 3 })).body;
  res = await call('POST', '/api/events', {
    cow_id: oadCow.id, event_type: 'dry_off', event_date: '2026-05-10',
    calving_date: '2026-08-20', drug_id: dryCowDrug.id
  });
  const oadEnd = addDays('2026-08-20', dryCowRule.milk_withdrawal_value);
  assert('once-a-day milking stretches the same label period to twice as many days',
    res.body.withdrawal_end_date === oadEnd,
    `expected ${oadEnd}, got ${res.body && res.body.withdrawal_end_date}`);
  await call('PUT', '/api/settings', { milkings_per_day: 2 });

  res = await call('PUT', '/api/settings', { milkings_per_day: 5 });
  assert('an implausible milking frequency is rejected', res.status === 400);

  res = await call('GET', '/api/milking-schedule');
  assert('GET /api/milking-schedule exposes the effective-dated baseline',
    res.status === 200 && res.body.current_milkings_per_day === 2
      && Array.isArray(res.body.entries) && res.body.entries.length === 1,
    JSON.stringify(res.body));

  res = await call('POST', '/api/milking-schedule', {
    effective_from: '2028-08-22', milkings_per_day: 1,
    note: 'Move from TAD to OAD after peak'
  });
  assert('a future seasonal milking change can be scheduled',
    res.status === 201 && res.body.effective_from === '2028-08-22'
      && res.body.milkings_per_day === 1,
    JSON.stringify(res.body));

  const transitionCow = (await call('POST', '/api/cows', {
    tag_number: '703', lactation_number: 3
  })).body;
  res = await call('POST', '/api/events', {
    cow_id: transitionCow.id, event_type: 'dry_off', event_date: '2028-05-01',
    calving_date: '2028-08-20', drug_id: dryCowDrug.id
  });
  assert('milkings are counted across a dated TAD-to-OAD transition',
    res.status === 201 && res.body.withdrawal_end_date === '2028-08-27'
      && res.body.milkings_per_day_applied === 2
      && /2028-08-22/.test(res.body.milking_schedule_snapshot || ''),
    JSON.stringify(res.body));

  res = await call('POST', '/api/events', {
    cow_id: transitionCow.id, event_type: 'dry_off', event_date: '2028-05-02',
    calving_date: '2028-08-20', drug_id: dryCowDrug.id, milkings_per_day: 2
  });
  assert('an event-level milking exception overrides the dated schedule and is snapshotted',
    res.status === 201 && res.body.withdrawal_end_date === '2028-08-24'
      && /event_override/.test(res.body.milking_schedule_snapshot || ''),
    JSON.stringify(res.body));

  res = await call('POST', '/api/milking-schedule', {
    effective_from: '2028-08-22', milkings_per_day: 2
  });
  assert('two milking changes cannot share the same effective date', res.status === 409);

  res = await call('POST', '/api/milking-schedule', {
    effective_from: '2028-02-31', milkings_per_day: 2
  });
  assert('a milking schedule rejects impossible dates', res.status === 400);

  // 提前产犊:Cepravin 标签不是简单报错,而是从治疗日起完成 49 天条件后再加
  // 产犊后的 8 次挤奶。这个分支最容易被旧 v4 语义误判成“无法计算”。
  const earlyCow = (await call('POST', '/api/cows', { tag_number: '602', lactation_number: 4 })).body;
  res = await call('POST', '/api/events', {
    cow_id: earlyCow.id, event_type: 'dry_off', event_date: '2026-06-01',
    calving_date: '2026-06-25', calving_date_source: 'actual', drug_id: dryCowDrug.id
  });
  const expectedEarlyCepravinEnd = addDays(
    '2026-06-01', dryCowRule.minimum_dry_period_days + dryCowDays
  );
  assert('Cepravin early-calving rule counts treatment + 49 days + 8 milkings',
    res.status === 201 && res.body.withdrawal_end_date === expectedEarlyCepravinEnd,
    `expected ${expectedEarlyCepravinEnd}, got ${res.body && res.body.withdrawal_end_date}`);

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'calcium', event_date: '2026-08-02'
  });
  assert('an event with no drug produces no withholding period',
    res.status === 201 && res.body.withdrawal_end_date === null);

  res = await call('POST', '/api/events', { cow_id: newCowId, event_type: 'treatment' });
  assert('POST /api/events without a date is rejected', res.status === 400);

  res = await call('POST', '/api/events', {
    cow_id: 99999, event_type: 'treatment', event_date: '2026-08-01'
  });
  assert('POST /api/events against an unknown cow returns 400', res.status === 400);

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'treatment', event_date: '2026-08-01', drug_id: 99999
  });
  assert('POST /api/events with an unknown drug returns 400', res.status === 400);

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'treatment', event_date: '2026-08-01', created_by: 99999
  });
  assert('POST /api/events ignores a forged creator and records the signed-in owner',
    res.status === 201 && res.body.created_by === owner.id, JSON.stringify(res.body));

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'levitation', event_date: '2026-08-01'
  });
  assert('POST /api/events with an invalid event type is rejected', res.status >= 400);

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'treatment', event_date: 'not-a-date'
  });
  assert('POST /api/events with a malformed date is rejected', res.status >= 400,
    `status=${res.status}`);

  // --------------------------------------------------------------- updating
  heading('Correcting an existing record');

  res = await call('PUT', `/api/events/${treatmentId}`, {
    event_date: '2026-08-05', correction_reason: 'Corrected from the treatment notebook'
  });
  const correctedEnd = addDays('2026-08-05', lactatingDays);
  assert('changing the event date recalculates the withholding snapshot',
    res.status === 200 && res.body.withdrawal_end_date === correctedEnd,
    `expected ${correctedEnd}, got ${res.body && res.body.withdrawal_end_date}`);

  res = await call('PUT', `/api/events/${dryOffId}`, {
    calving_date: '2026-09-01', correction_reason: 'Updated expected calving date'
  });
  const recalculatedDryEnd = addDays('2026-09-01', dryCowDays);
  assert('correcting the calving date recalculates a dry-cow withholding date',
    res.status === 200 && res.body.withdrawal_end_date === recalculatedDryEnd,
    `expected ${recalculatedDryEnd}, got ${res.body && res.body.withdrawal_end_date}`);

  res = await call('PUT', '/api/events/99999', { notes: 'x' });
  assert('PUT /api/events/:id on an unknown event returns 404', res.status === 404);

  res = await call('GET', `/api/events/${treatmentId}/corrections`);
  assert('the correction endpoint exposes the reason, actor and immutable snapshots',
    res.status === 200 && res.body.length === 1
      && res.body[0].reason === 'Corrected from the treatment notebook'
      && res.body[0].corrected_by === owner.id
      && JSON.parse(res.body[0].previous_snapshot).event_date === '2026-08-01'
      && JSON.parse(res.body[0].corrected_snapshot).event_date === '2026-08-05',
    JSON.stringify(res.body));

  res = await call('GET', '/api/reviews?status=open');
  assert('an automatically unprovable event stays visible in the open review queue',
    res.status === 200 && res.body.some(review => review.health_event_id === awaitingEventId),
    JSON.stringify(res.body));

  res = await call('PUT', `/api/events/${awaitingEventId}`, {
    calving_date: '2026-09-12', calving_date_source: 'predicted',
    correction_reason: 'Expected calving date supplied for planning'
  });
  assert('an expected date can calculate an estimate without pretending it is authoritative',
    res.status === 200 && res.body.withdrawal_status === 'calculated'
      && res.body.withdrawal_end_date !== null, JSON.stringify(res.body));

  res = await call('GET', '/api/reviews?status=open');
  assert('the review remains open while its clear date still rests on a prediction',
    res.status === 200 && res.body.some(review => review.health_event_id === awaitingEventId
      && /estimated clear date/i.test(review.reason)), JSON.stringify(res.body));

  res = await call('PUT', `/api/events/${awaitingEventId}`, {
    calving_date: '2026-09-10', calving_date_source: 'actual',
    correction_reason: 'Actual calving date supplied from the calving log'
  });
  assert('recording the actual date produces an authoritative withdrawal result',
    res.status === 200 && res.body.withdrawal_status === 'calculated'
      && res.body.calving_date_source === 'actual', JSON.stringify(res.body));

  res = await call('GET', '/api/reviews?status=resolved');
  assert('the accountable review is retained as resolved rather than disappearing',
    res.status === 200 && res.body.some(review => review.health_event_id === awaitingEventId
      && review.resolved_by === owner.id), JSON.stringify(res.body));

  // ------------------------------------------------- predicted vs actual calving
  heading('Reconciling a predicted calving date with the actual one');

  const earlyCalver = (await call('POST', '/api/cows', { tag_number: '603', lactation_number: 5 })).body;

  res = await call('POST', '/api/events', {
    cow_id: earlyCalver.id, event_type: 'dry_off', event_date: '2026-05-01',
    calving_date: '2026-09-15', drug_id: dryCowDrug.id, notes: 'dried off, expected mid-September'
  });
  const predictedEvent = res.body;
  assert('the dry-off record starts out based on an expected calving date',
    predictedEvent.calving_date_source === 'predicted' && predictedEvent.withdrawal_end_date !== null,
    JSON.stringify(predictedEvent.withdrawal_end_date));

  // 她提前六周产犊。记录产犊事件应当把上面那条的解除日重算。
  res = await call('POST', '/api/events', {
    cow_id: earlyCalver.id, event_type: 'calving', event_date: '2026-08-02',
    notes: 'calved six weeks early'
  });
  assert('recording a calving reports which dry-off records it corrected',
    Array.isArray(res.body.reconciled_dry_off_events) && res.body.reconciled_dry_off_events.length === 1,
    JSON.stringify(res.body.reconciled_dry_off_events));

  const corrected = (await call('GET', '/api/events')).body.find(e => e.id === predictedEvent.id);
  const expectedAfterCalving = addDays('2026-08-02', dryCowDays);
  assert('the clear date is recalculated from the date she actually calved',
    corrected.withdrawal_end_date === expectedAfterCalving,
    `expected ${expectedAfterCalving}, was ${predictedEvent.withdrawal_end_date}, got ${corrected.withdrawal_end_date}`);
  assert('the calving date is now recorded as a fact rather than an estimate',
    corrected.calving_date_source === 'actual' && corrected.calving_date === '2026-08-02',
    `${corrected.calving_date_source} / ${corrected.calving_date}`);
  assert('the number of days applied is unchanged, only the date it counts from',
    corrected.withdrawal_days_applied === predictedEvent.withdrawal_days_applied,
    `${predictedEvent.withdrawal_days_applied} -> ${corrected.withdrawal_days_applied}`);

  // 真正产犊后如果不足 49 天,对账也必须切换到标签的提前产犊规则。
  const veryEarly = (await call('POST', '/api/cows', { tag_number: '604', lactation_number: 2 })).body;
  await call('POST', '/api/events', {
    cow_id: veryEarly.id, event_type: 'dry_off', event_date: '2026-06-01',
    calving_date: '2026-09-01', drug_id: dryCowDrug.id
  });
  await call('POST', '/api/events', {
    cow_id: veryEarly.id, event_type: 'calving', event_date: '2026-06-20'
  });
  const breached = (await call('GET', '/api/events')).body
    .find(e => e.cow_id === veryEarly.id && e.event_type === 'dry_off');
  const expectedReconciledEarlyEnd = addDays(
    '2026-06-01', dryCowRule.minimum_dry_period_days + dryCowDays
  );
  assert('reconciling an early calving applies treatment + 49 days + 8 milkings',
    breached.withdrawal_end_date === expectedReconciledEarlyEnd,
    `expected ${expectedReconciledEarlyEnd}, got ${breached.withdrawal_end_date}`);

  // --------------------------------------------------------------- deletion
  heading('Soft deletion');

  res = await call('DELETE', `/api/events/${treatmentId}`);
  assert('DELETE /api/events/:id returns 204', res.status === 204);

  const remaining = (await call('GET', '/api/events')).body;
  assert('deleted event disappears from the list',
    !remaining.some(e => e.id === treatmentId));

  res = await call('DELETE', `/api/events/${treatmentId}`);
  assert('deleting the same event twice returns 404', res.status === 404);

  res = await call('PUT', `/api/events/${treatmentId}`, { notes: 'x' });
  assert('a deleted event cannot be updated', res.status === 404);

  // ---------------------------------------------------------- vat exclusions
  heading('Daily vat-exclusion list');

  res = await call('GET', '/api/vat-exclusions');
  assert('GET /api/vat-exclusions returns a list', res.status === 200 && Array.isArray(res.body));
  // 清单上的每一行要么给出解除日和剩余天数,要么明确说明为什么给不出来。
  // 不允许既没有日期也没有理由的行——那种行会被当成噪音跳过。
  assert('every entry either gives a clear date or says why it cannot',
    res.body.every(r => r.tag_number && (
      (r.withdrawal_end_date && typeof r.days_remaining === 'number') ||
      (r.requires_attention === true && r.warnings.length > 0)
    )),
    JSON.stringify(res.body.filter(r =>
      !(r.withdrawal_end_date || (r.requires_attention && r.warnings.length)))));
  assert('a calculated hold exposes the next day as the earliest eligible date',
    res.body.filter(r => r.withdrawal_end_date).every(r =>
      r.eligible_from_date === addDays(r.withdrawal_end_date, 1)),
    JSON.stringify(res.body));
  assert('soft-deleted treatments are excluded from the list',
    !res.body.some(r => r.id === treatmentId));

  assert('cows whose clear date rests on an expected calving date are flagged as estimates',
    res.body.some(r => r.is_estimate === true && r.warnings.some(w => /expected calving date/.test(w))),
    JSON.stringify(res.body.filter(r => r.is_estimate).slice(0, 2)));

  // 算不出解除日的牛最危险,却最容易从按日期筛选的清单里漏掉。
  assert('verified active references no longer emit an unverified-data warning',
    res.body.every(r => !r.warnings.some(w => /not been verified/i.test(w))),
    JSON.stringify(res.body));

  // ------------------------------------------------------ read-only assistant
  heading('Constrained natural-language assistant');

  const directVatRows = res.body;
  res = await call('POST', '/api/assistant/query', {
    question: 'Which cows must stay out of the vat today?'
  });
  assert('the assistant recognises the supported read-only vat question',
    res.status === 200 && res.body.supported === true
      && res.body.source === 'deterministic_database_query', JSON.stringify(res.body));
  assert('the assistant returns the same authoritative rows as the existing vat endpoint',
    res.body.count === directVatRows.length
      && res.body.rows.map(row => row.id).join(',') === directVatRows.map(row => row.id).join(','),
    JSON.stringify({ assistant: res.body.rows, direct: directVatRows }));
  assert('the assistant exposes that the local constrained matcher was used without an API key',
    res.body.assistant_mode === 'local' && /not configured/i.test(res.body.notice),
    JSON.stringify(res.body));

  res = await call('POST', '/api/assistant/query', {
    question: '今天哪些牛的奶不能进奶罐？'
  });
  assert('the constrained assistant also recognises the supported Chinese question',
    res.status === 200 && res.body.supported === true && res.body.count === directVatRows.length,
    JSON.stringify(res.body));

  res = await call('POST', '/api/assistant/query', { question: 'Diagnose cow 212 for me' });
  assert('unsupported or clinical requests are refused instead of guessed',
    res.status === 200 && res.body.supported === false && !Object.hasOwn(res.body, 'rows'),
    JSON.stringify(res.body));

  res = await call('POST', '/api/assistant/query', { question: '' });
  assert('the assistant rejects an empty question', res.status === 400);

  // ------------------------------------------------------ drug data verification
  heading('Versioned and verified ACVM reference data');

  res = await call('GET', '/api/drugs/unverified');
  assert('there are no unverified active drugs',
    res.status === 200 && res.body.count === 0 && res.body.drugs.length === 0,
    JSON.stringify(res.body));

  res = await call('GET', '/api/drugs/reference-status');
  const referenceStatus = res.body;
  assert('reference-status reports five verified active drugs and one inactive drug',
    res.status === 200
      && referenceStatus.active_count === 5
      && referenceStatus.verified_active_count === 5
      && referenceStatus.unverified_active_count === 0
      && referenceStatus.inactive_count === 1,
    JSON.stringify(referenceStatus));
  const inactiveBovaclox = Array.isArray(referenceStatus.drugs)
    ? referenceStatus.drugs.find(d => d.drug_name === 'Bovaclox DC Xtra')
    : null;
  assert('Bovaclox DC Xtra is retained for history but inactive and unverified',
    inactiveBovaclox && inactiveBovaclox.is_active === 0 && inactiveBovaclox.is_verified === false,
    JSON.stringify(inactiveBovaclox));

  assert('every active drug carries complete ACVM provenance',
    drugs.every(d => d.acvm_registration_no && d.label_revision && d.verified_on
      && d.verified_by && d.source_reference && d.label_wording),
    JSON.stringify(drugs.map(d => ({
      drug_name: d.drug_name,
      acvm_registration_no: d.acvm_registration_no,
      label_revision: d.label_revision,
      verified_on: d.verified_on,
      verified_by: d.verified_by
    }))));

  assert('Orbenin advertises that a regimen choice is mandatory',
    orbenin.requires_regimen === 1 && orbenin.rules.length > 1,
    JSON.stringify(orbenin));
  assert('Mastalone is 8 milkings with a 30-day meat withholding period',
    mastalone.milk_withdrawal_value === 8
      && mastalone.milk_withdrawal_unit === 'milkings'
      && mastalone.meat_withdrawal_days === 30,
    JSON.stringify(mastalone));
  assert('Penethaject is penethamate with a 48-hour milk and 7-day meat period',
    /penethamate/i.test(penethaject.active_ingredient)
      && penethaject.milk_withdrawal_value === 48
      && penethaject.milk_withdrawal_unit === 'hours'
      && penethaject.meat_withdrawal_days === 7,
    JSON.stringify(penethaject));
  assert('Cepravin records the 49-day condition and 8 milkings',
    dryCowRule.minimum_dry_period_days === 49
      && dryCowRule.milk_withdrawal_value === 8
      && dryCowRule.milk_withdrawal_unit === 'milkings',
    JSON.stringify(dryCowRule));
  assert('TeatSeal is counted from calving and requires 8 milkings',
    teatSeal.calculation_basis === 'calving_date'
      && teatSeal.milk_withdrawal_value === 8
      && teatSeal.milk_withdrawal_unit === 'milkings',
    JSON.stringify(teatSeal));

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'dry_off', event_date: '2026-08-01', drug_id: teatSeal.id
  });
  assert('TeatSeal waits for a calving date instead of counting from treatment',
    res.status === 201 && res.body.withdrawal_end_date === null
      && res.body.withdrawal_status === 'awaiting_calving_date',
    JSON.stringify(res.body));

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'dry_off', event_date: '2026-08-01',
    calving_date: '2026-09-01', calving_date_source: 'actual', drug_id: teatSeal.id
  });
  assert('TeatSeal clears after 8 milkings from calving',
    res.status === 201 && res.body.withdrawal_end_date === '2026-09-05',
    JSON.stringify(res.body));

  // ------------------------------------------------------------------- SCC
  heading('SCC records');

  res = await call('POST', '/api/scc', { cow_id: newCowId, test_date: '2026-06-20', scc_value: 320000 });
  const sccId = res.body && res.body.id;
  assert('POST /api/scc creates a record', res.status === 201);

  res = await call('POST', '/api/scc', { cow_id: newCowId, test_date: '2026-06-20', scc_value: 999 });
  assert('a duplicate SCC test for the same cow, date and source is rejected', res.status >= 400,
    `status=${res.status}`);

  res = await call('POST', '/api/scc', { cow_id: newCowId, test_date: '2026-06-21', scc_value: -1 });
  assert('a negative SCC value is rejected', res.status >= 400, `status=${res.status}`);

  res = await call('POST', '/api/scc', { cow_id: newCowId, scc_value: 100 });
  assert('POST /api/scc without a test date is rejected', res.status === 400);

  // ------------------------------------------------------ dry-off decisions
  heading('Dry-off recommendation and decisions');

  res = await call('GET', `/api/cows/${newCowId}/dry-off-recommendation?season=2026-27`);
  assert('a cow above the SCC threshold is recommended antibiotic therapy',
    res.status === 200 && res.body.recommendation === 'antibiotic_dct',
    JSON.stringify(res.body));
  assert('the recommendation states which criterion triggered it',
    res.body.criteria_met && res.body.criteria_met.length > 0,
    JSON.stringify(res.body.criteria_met));

  const cleanCow = (await call('POST', '/api/cows', { tag_number: '556', lactation_number: 3 })).body;
  await call('POST', '/api/scc', { cow_id: cleanCow.id, test_date: '2026-06-20', scc_value: 80000 });
  res = await call('GET', `/api/cows/${cleanCow.id}/dry-off-recommendation?season=2026-27`);
  assert('a cow below the threshold with no mastitis is recommended teat seal only',
    res.status === 200 && res.body.recommendation === 'teat_seal_only',
    JSON.stringify(res.body));

  const firstLactationCow = (await call('POST', '/api/cows', { tag_number: '557', lactation_number: 1 })).body;
  await call('POST', '/api/scc', { cow_id: firstLactationCow.id, test_date: '2026-06-20', scc_value: 130000 });
  res = await call('GET', `/api/cows/${firstLactationCow.id}/dry-off-recommendation?season=2026-27`);
  assert('130,000 triggers therapy for a first-lactation cow but would not for a mature cow',
    res.body.recommendation === 'antibiotic_dct' && res.body.evidence.threshold_applied === 125000,
    JSON.stringify(res.body));

  const unknownCow = (await call('POST', '/api/cows', { tag_number: '558', lactation_number: 4 })).body;
  res = await call('GET', `/api/cows/${unknownCow.id}/dry-off-recommendation?season=2026-27`);
  assert('a cow with no data gets no recommendation rather than a false all-clear',
    res.body.recommendation === null && res.body.sufficient_evidence === false,
    JSON.stringify(res.body));

  res = await call('GET', '/api/cows/99999/dry-off-recommendation');
  assert('a recommendation for an unknown cow returns 404', res.status === 404);

  res = await call('POST', '/api/decisions', {
    cow_id: newCowId, season: '2026-27', decision: 'antibiotic_dct',
    justification: 'SCC 320,000', supporting_scc_id: sccId
  });
  assert('POST /api/decisions records a decision with its evidence', res.status === 201);

  res = await call('POST', '/api/decisions', {
    cow_id: newCowId, season: '2026-27', decision: 'teat_seal_only'
  });
  assert('a second, conflicting decision for the same cow and season is rejected',
    res.status === 400, `status=${res.status}`);

  res = await call('POST', '/api/decisions', {
    cow_id: newCowId, season: '2027-28', decision: 'antibiotic_dct', decided_by: 99999
  });
  assert('a forged decision actor is ignored in favour of the signed-in owner',
    res.status === 201 && res.body.decided_by === owner.id, JSON.stringify(res.body));

  // ------------------------------------------------------------------ users
  heading('Users');

  res = await call('POST', '/api/users', {
    name: 'Weekend Milker', username: 'weekend', password: 'weekend-2026', role: 'milker'
  });
  assert('POST /api/users creates a credentialled user without exposing password fields',
    res.status === 201 && res.body.username === 'weekend'
      && !Object.hasOwn(res.body, 'password_hash') && !Object.hasOwn(res.body, 'password_salt'),
    JSON.stringify(res.body));

  res = await call('POST', '/api/users', {
    name: 'Nobody', username: 'nobody', password: 'nobody-2026', role: 'president'
  });
  assert('an invalid role is rejected', res.status >= 400, `status=${res.status}`);

  res = await call('POST', '/api/users', { role: 'milker' });
  assert('POST /api/users without a name is rejected', res.status === 400);

  res = await call('GET', '/api/users');
  assert('GET /api/users never exposes password salts or hashes',
    res.status === 200 && res.body.every(user => !Object.hasOwn(user, 'password_hash')
      && !Object.hasOwn(user, 'password_salt')), JSON.stringify(res.body));

  // ---------------------------------------------------------- field feedback
  heading('Field usability feedback');

  res = await call('POST', '/api/feedback', {
    area: 'dashboard', task_code: 'find_hold', completion_status: 'completed_with_help',
    ease_rating: 3, confusing_part: 'I needed the inclusive date explained.',
    suggestion: 'Keep the earliest eligible date beside the hold date.'
  });
  assert('POST /api/feedback saves a structured response under the signed-in user',
    res.status === 201 && res.body.submitted_by === owner.id && res.body.ease_rating === 3,
    JSON.stringify(res.body));

  res = await call('POST', '/api/feedback', {
    area: 'dashboard', task_code: 'find_hold', completion_status: 'completed', ease_rating: 7
  });
  assert('field feedback rejects a rating outside 1 to 5', res.status === 400);

  res = await call('GET', '/api/feedback');
  assert('the owner can review field feedback with participant role context',
    res.status === 200 && res.body.length === 1
      && res.body[0].submitted_by_role === 'owner', JSON.stringify(res.body));

  // ------------------------------------------------ role-based authorisation
  heading('Role-based authorisation');

  res = await login('milker', 'calving-milker-2026');
  assert('the seeded milker can sign in', res.status === 200 && res.body.role === 'milker');

  res = await call('POST', '/api/milking-schedule', {
    effective_from: '2029-01-01', milkings_per_day: 1
  });
  assert('a milker cannot change farm settings', res.status === 403);

  res = await call('PUT', `/api/events/${dryOffId}`, {
    notes: 'attempted change', correction_reason: 'Milker tried to amend the record'
  });
  assert('a milker cannot correct an existing health event', res.status === 403);

  res = await call('POST', '/api/decisions', {
    cow_id: cleanCow.id, season: '2028-29', decision: 'teat_seal_only'
  });
  assert('a milker cannot record the accountable dry-off decision', res.status === 403);

  res = await call('POST', '/api/users', {
    name: 'Unauthorised', username: 'unauthorised', password: 'password-2026', role: 'milker'
  });
  assert('a milker cannot create another account', res.status === 403);

  res = await call('POST', '/api/feedback', {
    area: 'overall', task_code: 'overall_walkthrough', completion_status: 'completed',
    ease_rating: 4, suggestion: 'The larger type was easier to read.'
  });
  assert('a milker can submit their own usability feedback',
    res.status === 201 && res.body.submitted_by_role === 'milker', JSON.stringify(res.body));

  res = await call('GET', '/api/feedback');
  assert('a milker cannot read other participants\' feedback', res.status === 403);
}

// ---------------------------------------------------------------------------

fs.rmSync(TEST_DB, { force: true });

const server = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    CALVING_LOG_DB: TEST_DB,
    PORT: String(PORT),
    OPENAI_API_KEY: '',
    OPENAI_MODEL: ''
  },
  stdio: ['ignore', 'ignore', 'pipe']
});

let serverErrors = '';
server.stderr.on('data', chunk => { serverErrors += chunk.toString(); });

(async () => {
  try {
    if (!await waitForServer()) {
      console.error(red('Server did not start.'));
      if (serverErrors) console.error(serverErrors);
      process.exitCode = 1;
      return;
    }

    await run();

    console.log('\n' + '='.repeat(60));
    if (failed === 0) {
      console.log(green(bold(`  ${passed} tests passed.`)));
    } else {
      console.log(red(bold(`  ${failed} of ${passed + failed} tests failed.`)));
      if (serverErrors) console.log(dim('\nServer stderr:\n' + serverErrors));
    }
    console.log('='.repeat(60) + '\n');

    process.exitCode = failed === 0 ? 0 : 1;
  } catch (error) {
    console.error(red('\nTest run crashed: ' + error.stack));
    if (serverErrors) console.error(dim(serverErrors));
    process.exitCode = 1;
  } finally {
    // Windows 上子进程要真正退出、放开文件句柄之后才能删掉测试库,
    // kill() 本身是异步的,直接删会撞上 EPERM。
    await new Promise(resolve => {
      server.once('exit', resolve);
      server.kill();
      setTimeout(resolve, 3000).unref();
    });

    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(TEST_DB + suffix, { force: true }); } catch { /* 留给系统临时目录清理 */ }
    }
  }
})();
