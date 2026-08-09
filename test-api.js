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

async function call(method, url, body) {
  const response = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 204 等无内容响应 */ }
  return { status: response.status, body: json };
}

async function waitForServer(attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fetch(BASE + '/api/cows');
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

  // ------------------------------------------------------------------- cows
  heading('Cows');

  let res = await call('GET', '/api/cows');
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

  const drugs = (await call('GET', '/api/drugs')).body;
  const lactatingDrug = drugs.find(d => d.calculation_basis === 'treatment_date' && d.milk_withdrawal_days > 0);
  const dryCowDrug = drugs.find(d => d.calculation_basis === 'calving_date');

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'treatment', event_date: '2026-08-01',
    drug_id: lactatingDrug.id, diagnosis: 'clinical_mastitis', notes: 'test treatment'
  });
  const treatmentId = res.body && res.body.id;
  const expectedEnd = new Date(Date.UTC(2026, 7, 1 + lactatingDrug.milk_withdrawal_days))
    .toISOString().split('T')[0];
  assert('lactating-cow drug counts from the treatment date',
    res.status === 201 && res.body.withdrawal_end_date === expectedEnd,
    `expected ${expectedEnd}, got ${res.body && res.body.withdrawal_end_date}`);

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'dry_off', event_date: '2026-05-10',
    calving_date: '2026-08-20', drug_id: dryCowDrug.id
  });
  const dryOffId = res.body && res.body.id;
  const expectedDryEnd = new Date(Date.UTC(2026, 7, 20 + dryCowDrug.milk_withdrawal_days))
    .toISOString().split('T')[0];
  assert('dry-cow drug counts from the calving date, not the treatment date',
    res.status === 201 && res.body.withdrawal_end_date === expectedDryEnd,
    `expected ${expectedDryEnd}, got ${res.body && res.body.withdrawal_end_date}`);

  res = await call('POST', '/api/events', {
    cow_id: newCowId, event_type: 'dry_off', event_date: '2026-05-11', drug_id: dryCowDrug.id
  });
  assert('dry-cow drug with no calving date yields no withholding date rather than a wrong one',
    res.status === 201 && res.body.withdrawal_end_date === null,
    `got ${res.body && res.body.withdrawal_end_date}`);

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
  assert('POST /api/events with an unknown user returns 400 rather than 500', res.status === 400,
    `status=${res.status}`);

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

  res = await call('PUT', `/api/events/${treatmentId}`, { event_date: '2026-08-05' });
  const correctedEnd = new Date(Date.UTC(2026, 7, 5 + lactatingDrug.milk_withdrawal_days))
    .toISOString().split('T')[0];
  assert('changing the event date recalculates the withholding snapshot',
    res.status === 200 && res.body.withdrawal_end_date === correctedEnd,
    `expected ${correctedEnd}, got ${res.body && res.body.withdrawal_end_date}`);

  res = await call('PUT', `/api/events/${dryOffId}`, { calving_date: '2026-09-01' });
  const recalculatedDryEnd = new Date(Date.UTC(2026, 8, 1 + dryCowDrug.milk_withdrawal_days))
    .toISOString().split('T')[0];
  assert('correcting the calving date recalculates a dry-cow withholding date',
    res.status === 200 && res.body.withdrawal_end_date === recalculatedDryEnd,
    `expected ${recalculatedDryEnd}, got ${res.body && res.body.withdrawal_end_date}`);

  res = await call('PUT', '/api/events/99999', { notes: 'x' });
  assert('PUT /api/events/:id on an unknown event returns 404', res.status === 404);

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
  assert('every entry carries a tag number, clear date and days remaining',
    res.body.every(r => r.tag_number && r.withdrawal_end_date && typeof r.days_remaining === 'number'),
    JSON.stringify(res.body));
  assert('soft-deleted treatments are excluded from the list',
    !res.body.some(r => r.id === treatmentId));

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
  assert('a decision by an unknown user returns 400', res.status === 400);

  // ------------------------------------------------------------------ users
  heading('Users');

  res = await call('POST', '/api/users', { name: 'Weekend Milker', role: 'milker' });
  assert('POST /api/users creates a user', res.status === 201);

  res = await call('POST', '/api/users', { name: 'Nobody', role: 'president' });
  assert('an invalid role is rejected', res.status >= 400, `status=${res.status}`);

  res = await call('POST', '/api/users', { role: 'milker' });
  assert('POST /api/users without a name is rejected', res.status === 400);
}

// ---------------------------------------------------------------------------

fs.rmSync(TEST_DB, { force: true });

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, CALVING_LOG_DB: TEST_DB, PORT: String(PORT) },
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
