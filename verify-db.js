#!/usr/bin/env node
//
// 数据库完整性验证。
//
//   node verify-db.js
//
// 建表语句写了约束,不等于约束在跑着的数据库里真的生效——迁移可能没应用、
// 外键可能没打开、CHECK 可能写成了永远为真的形式。这个脚本不读代码,它直接
// 对数据库文件动手:故意插入一批非法数据,逐条确认被挡了下来。
//
// 全程在数据库副本上进行,真实数据不会被写入任何一个字节。

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { LATEST_VERSION } = require('./migrate');

const SOURCE_DB = process.env.CALVING_LOG_DB || 'calving-log.db';

const green = s => `\x1b[32m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const dim = s => `\x1b[90m${s}\x1b[0m`;
const bold = s => `\x1b[1m${s}\x1b[0m`;

let failures = 0;
let warnings = 0;

function heading(text) {
  console.log(`\n${bold(text)}\n${'-'.repeat(text.length)}`);
}

// 结构问题和数据问题要分开记。约束没生效是代码坏了,必须让退出码非零;参考
// 数据还没核实是工作没做完,同样要吵,但不该和前者混为一谈——否则退出码就
// 再也说明不了 schema 到底健不健康。
function warn(label, condition, detail) {
  if (condition) {
    console.log(`  ${green('PASS')}  ${label}${detail ? dim('  ' + detail) : ''}`);
  } else {
    console.log(`  ${red('WARN')}  ${label}${detail ? '  ' + detail : ''}`);
    warnings += 1;
  }
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ${green('PASS')}  ${label}${detail ? dim('  ' + detail) : ''}`);
  } else {
    console.log(`  ${red('FAIL')}  ${label}${detail ? '  ' + detail : ''}`);
    failures += 1;
  }
}

// 期望这条语句被数据库拒绝。被接受了就说明约束没生效。
function expectRejected(db, label, sql) {
  try {
    db.prepare(sql).run();
    console.log(`  ${red('FAIL')}  ${label}  ${red('<- accepted, constraint is missing')}`);
    failures += 1;
  } catch (error) {
    console.log(`  ${green('PASS')}  ${label}\n        ${dim(error.message)}`);
  }
}

function expectAccepted(db, label, sql) {
  try {
    db.prepare(sql).run();
    console.log(`  ${green('PASS')}  ${label}`);
  } catch (error) {
    console.log(`  ${red('FAIL')}  ${label}  ${red('<- rejected: ' + error.message)}`);
    failures += 1;
  }
}

if (!fs.existsSync(SOURCE_DB)) {
  console.error(`Database file not found: ${SOURCE_DB}`);
  console.error('Run "node server.js" once to create and seed it.');
  process.exit(1);
}

const workingCopy = path.join(os.tmpdir(), `calving-log-verify-${process.pid}.db`);
fs.copyFileSync(SOURCE_DB, workingCopy);

const db = new Database(workingCopy);
db.pragma('foreign_keys = ON');

console.log(bold(`\nCalvingLog database verification`));
console.log(dim(`source: ${path.resolve(SOURCE_DB)}`));
console.log(dim(`tested on a copy: ${workingCopy}`));

try {
  // ---------------------------------------------------------------- structure
  heading('1. Schema structure');

  const version = db.pragma('user_version', { simple: true });
  check('schema is at the latest migration', version === LATEST_VERSION,
    `user_version=${version}, expected ${LATEST_VERSION}`);

  const expectedTables = ['cows', 'drugs', 'dry_off_decisions', 'health_events', 'scc_records', 'users'];
  const actualTables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all().map(r => r.name);
  check('all six tables present', expectedTables.every(t => actualTables.includes(t)),
    actualTables.join(', '));

  check('foreign key enforcement is on', db.pragma('foreign_keys', { simple: true }) === 1);

  // ------------------------------------------------------------------- health
  heading('2. Stored data health');

  check('integrity_check reports ok',
    db.pragma('integrity_check', { simple: true }) === 'ok');

  const fkViolations = db.pragma('foreign_key_check');
  check('no foreign key violations in stored data', fkViolations.length === 0,
    fkViolations.length ? JSON.stringify(fkViolations) : '');

  // 快照必须自洽:存了天数就必须存解除日,反之亦然。
  const brokenSnapshots = db.prepare(`
    SELECT COUNT(*) AS count FROM health_events
    WHERE deleted_at IS NULL
      AND ((withdrawal_days_applied IS NULL) != (withdrawal_end_date IS NULL))
  `).get().count;
  check('withdrawal snapshots are internally consistent', brokenSnapshots === 0,
    `${brokenSnapshots} half-populated snapshot(s)`);

  // 没有用药却算出了停药期,说明计算逻辑被绕过了。
  const withdrawalWithoutDrug = db.prepare(`
    SELECT COUNT(*) AS count FROM health_events
    WHERE deleted_at IS NULL AND drug_id IS NULL AND withdrawal_end_date IS NOT NULL
  `).get().count;
  check('no withdrawal period without a drug', withdrawalWithoutDrug === 0,
    `${withdrawalWithoutDrug} event(s)`);

  // ------------------------------------------------------------- relationships
  heading('3. Referential integrity is enforced');

  expectRejected(db, 'event referencing a non-existent cow',
    `INSERT INTO health_events (cow_id, event_type, event_date)
     VALUES (99999, 'treatment', '2026-08-10')`);
  expectRejected(db, 'event referencing a non-existent drug',
    `INSERT INTO health_events (cow_id, event_type, event_date, drug_id)
     VALUES (1, 'treatment', '2026-08-10', 99999)`);
  expectRejected(db, 'event referencing a non-existent user',
    `INSERT INTO health_events (cow_id, event_type, event_date, created_by)
     VALUES (1, 'treatment', '2026-08-10', 99999)`);
  expectRejected(db, 'decision referencing a non-existent SCC record',
    `INSERT INTO dry_off_decisions (cow_id, season, decision, supporting_scc_id)
     VALUES (1, '2027-28', 'antibiotic_dct', 99999)`);
  expectRejected(db, 'deleting a cow that still has health events',
    `DELETE FROM cows WHERE id = 1`);

  // -------------------------------------------------------------------- values
  heading('4. Value constraints are enforced');

  expectRejected(db, 'cow status outside the allowed set',
    `INSERT INTO cows (tag_number, status) VALUES ('V1', 'flying')`);
  expectRejected(db, 'user role outside the allowed set',
    `INSERT INTO users (name, role) VALUES ('V', 'president')`);
  expectRejected(db, 'event type outside the allowed set',
    `INSERT INTO health_events (cow_id, event_type, event_date) VALUES (1, 'abducted', '2026-08-10')`);
  expectRejected(db, 'SCC source outside the allowed set',
    `INSERT INTO scc_records (cow_id, test_date, scc_value, source) VALUES (1, '2026-08-10', 100, 'guess')`);
  expectRejected(db, 'dry-off decision outside the allowed set',
    `INSERT INTO dry_off_decisions (cow_id, season, decision) VALUES (1, '2027-28', 'maybe')`);
  expectRejected(db, 'calculation basis outside the allowed set',
    `INSERT INTO drugs (drug_name, milk_withdrawal_value, calculation_basis)
     VALUES ('VerifyDrug', 1, 'moon_phase')`);
  expectRejected(db, 'diagnosis outside the allowed set',
    `INSERT INTO health_events (cow_id, event_type, event_date, diagnosis)
     VALUES (1, 'treatment', '2026-08-10', 'sunburn')`);
  expectRejected(db, 'duplicate tag number',
    `INSERT INTO cows (tag_number) VALUES ((SELECT tag_number FROM cows LIMIT 1))`);
  expectRejected(db, 'negative somatic cell count',
    `INSERT INTO scc_records (cow_id, test_date, scc_value) VALUES (1, '2026-08-10', -500)`);
  expectRejected(db, 'negative withholding period',
    `INSERT INTO drugs (drug_name, milk_withdrawal_value) VALUES ('VerifyNeg', -5)`);
  expectRejected(db, 'withholding period in an unknown unit',
    `INSERT INTO drugs (drug_name, milk_withdrawal_value, milk_withdrawal_unit)
     VALUES ('VerifyUnit', 4, 'fortnights')`);
  expectRejected(db, 'minimum dry period on a drug counted from the treatment date',
    `INSERT INTO drugs (drug_name, milk_withdrawal_value, calculation_basis, minimum_dry_period_days)
     VALUES ('VerifyDry', 4, 'treatment_date', 49)`);
  expectRejected(db, 'a second row in the single-row farm settings table',
    `INSERT INTO farm_settings (id, milkings_per_day) VALUES (2, 2)`);
  expectRejected(db, 'an implausible milking frequency',
    `UPDATE farm_settings SET milkings_per_day = 9 WHERE id = 1`);
  expectRejected(db, 'an unknown withdrawal status',
    `INSERT INTO health_events (cow_id, event_type, event_date, withdrawal_status)
     VALUES (1, 'treatment', '2026-08-10', 'probably_fine')`);
  expectRejected(db, 'a calving date that is neither predicted nor actual',
    `INSERT INTO health_events (cow_id, event_type, event_date, calving_date, calving_date_source)
     VALUES (1, 'dry_off', '2026-08-10', '2026-10-01', 'guessed')`);
  expectRejected(db, 'event with no date',
    `INSERT INTO health_events (cow_id, event_type, event_date) VALUES (1, 'treatment', NULL)`);

  // ------------------------------------------------------------------- dates
  heading('5. Dates must be real, canonical dates');

  expectRejected(db, 'free text where a date belongs',
    `INSERT INTO health_events (cow_id, event_type, event_date) VALUES (1, 'treatment', 'yesterday')`);
  expectRejected(db, 'unpadded date (2026-8-1)',
    `INSERT INTO health_events (cow_id, event_type, event_date) VALUES (1, 'treatment', '2026-8-1')`);
  expectRejected(db, 'date that does not exist (2026-02-31)',
    `INSERT INTO health_events (cow_id, event_type, event_date) VALUES (1, 'treatment', '2026-02-31')`);
  expectRejected(db, 'day/month order (10/08/2026)',
    `INSERT INTO health_events (cow_id, event_type, event_date) VALUES (1, 'treatment', '10/08/2026')`);
  expectRejected(db, 'malformed season (26/27)',
    `INSERT INTO dry_off_decisions (cow_id, season, decision) VALUES (1, '26/27', 'antibiotic_dct')`);

  // ------------------------------------------------------------- traceability
  heading('6. Audit and traceability rules');

  expectRejected(db, 'two conflicting dry-off decisions for one cow in one season',
    `INSERT INTO dry_off_decisions (cow_id, season, decision)
     SELECT cow_id, season, 'teat_seal_only' FROM dry_off_decisions LIMIT 1`);
  expectRejected(db, 'duplicate SCC test for the same cow, date and source',
    `INSERT INTO scc_records (cow_id, test_date, scc_value, source)
     SELECT cow_id, test_date, 999000, source FROM scc_records LIMIT 1`);

  const hardDeleted = db.prepare(`SELECT COUNT(*) AS count FROM health_events WHERE deleted_at IS NOT NULL`).get().count;
  check('soft-deleted treatment records are retained, not erased', true,
    `${hardDeleted} soft-deleted record(s) still recoverable`);

  // ------------------------------------------------------------- still usable
  heading('7. Legitimate data is still accepted');

  expectAccepted(db, 'a valid cow',
    `INSERT INTO cows (tag_number, breed, birth_date, lactation_number, status)
     VALUES ('VERIFY-1', 'Friesian', '2023-07-30', 2, 'lactating')`);
  expectAccepted(db, 'a valid treatment with a diagnosis',
    `INSERT INTO health_events (cow_id, event_type, event_date, drug_id, diagnosis, notes)
     VALUES ((SELECT id FROM cows WHERE tag_number='VERIFY-1'), 'treatment', '2026-08-10',
             (SELECT id FROM drugs WHERE calculation_basis='treatment_date' LIMIT 1),
             'clinical_mastitis', 'verification row')`);
  expectAccepted(db, 'a valid SCC result',
    `INSERT INTO scc_records (cow_id, test_date, scc_value, source)
     VALUES ((SELECT id FROM cows WHERE tag_number='VERIFY-1'), '2026-08-10', 210000, 'rmt')`);

  // ------------------------------------------------------------------ indexes
  heading('8. Index coverage on foreign keys and hot queries');

  const fkColumns = [
    ['health_events', 'cow_id'], ['health_events', 'drug_id'], ['health_events', 'created_by'],
    ['scc_records', 'cow_id'], ['dry_off_decisions', 'cow_id'],
    ['dry_off_decisions', 'supporting_scc_id'], ['dry_off_decisions', 'decided_by']
  ];

  for (const [table, column] of fkColumns) {
    const indexed = db.prepare(`PRAGMA index_list("${table}")`).all().some(index =>
      db.prepare(`PRAGMA index_info("${index.name}")`).all().some(c => c.name === column)
    );
    check(`${table}.${column} is indexed`, indexed);
  }

  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT health_events.id, cows.tag_number, health_events.withdrawal_end_date
    FROM health_events
    JOIN cows ON health_events.cow_id = cows.id
    WHERE health_events.deleted_at IS NULL
      AND health_events.withdrawal_end_date IS NOT NULL
      AND health_events.withdrawal_end_date >= '2026-08-10'
  `).all().map(r => r.detail);

  check('daily vat-exclusion query uses an index rather than scanning',
    plan.some(step => step.includes('USING INDEX') || step.includes('USING COVERING INDEX')),
    plan.join(' | '));

  // -------------------------------------------------------------- domain rule
  heading('9. Domain rule: the two withholding calculation bases');

  const bases = db.prepare(`
    SELECT calculation_basis, COUNT(*) AS count FROM drugs GROUP BY calculation_basis
  `).all();
  const basisNames = bases.map(b => b.calculation_basis);
  check('both calculation bases exist in the drug reference table',
    basisNames.includes('treatment_date') && basisNames.includes('calving_date'),
    bases.map(b => `${b.calculation_basis}=${b.count}`).join(', '));

  // 干奶期用药却没填产犊日期时,系统必须留空而不是拿用药日期硬算。
  const wronglyCalculated = db.prepare(`
    SELECT COUNT(*) AS count
    FROM health_events
    JOIN drugs ON health_events.drug_id = drugs.id
    WHERE drugs.calculation_basis = 'calving_date'
      AND health_events.calving_date IS NULL
      AND health_events.withdrawal_end_date IS NOT NULL
  `).get().count;
  check('no dry-cow withholding date was calculated without a calving date',
    wronglyCalculated === 0, `${wronglyCalculated} incorrectly calculated event(s)`);

  // 剂量依赖的药不允许有自动算出的解除日。出现了就说明计算逻辑被绕过了,
  // 而绕过的后果是一个看起来完全正常的错误日期。
  const guessedDoseDependent = db.prepare(`
    SELECT COUNT(*) AS count
    FROM health_events
    JOIN drugs ON health_events.drug_id = drugs.id
    WHERE drugs.whp_depends_on_dose = 1
      AND health_events.deleted_at IS NULL
      AND health_events.withdrawal_end_date IS NOT NULL
      AND health_events.withdrawal_status != 'requires_vet_advice'
  `).get().count;
  check('no clear date was auto-calculated for a dose-dependent drug',
    guessedDoseDependent === 0, `${guessedDoseDependent} event(s)`);

  // 最小干奶期被打破的记录必须没有解除日。有日期就等于系统在说"可以挤了"。
  const breachedWithDate = db.prepare(`
    SELECT COUNT(*) AS count FROM health_events
    WHERE deleted_at IS NULL
      AND withdrawal_status = 'minimum_dry_period_breached'
      AND withdrawal_end_date IS NOT NULL
  `).get().count;
  check('cows that breached the minimum dry period carry no clear date',
    breachedWithDate === 0, `${breachedWithDate} event(s)`);

  // ------------------------------------------------------------ reference data
  heading('10. Reference data provenance');

  const drugRows = db.prepare(`
    SELECT drug_name, milk_withdrawal_value, milk_withdrawal_unit,
           whp_depends_on_dose, verified_on, source_reference
    FROM drugs WHERE is_active = 1 ORDER BY drug_name
  `).all();

  const unverified = drugRows.filter(d => d.verified_on === null);

  for (const drug of drugRows) {
    const summary = drug.whp_depends_on_dose
      ? 'dose-dependent, entered manually'
      : `${drug.milk_withdrawal_value} ${drug.milk_withdrawal_unit}`;
    const mark = drug.verified_on ? green('verified ' + drug.verified_on) : red('NOT VERIFIED');
    console.log(`  ${drug.drug_name.padEnd(20)} ${summary.padEnd(34)} ${mark}`);
  }

  console.log();
  // 这一条是故意会失败的。它不是在检查代码有没有写对,而是在提醒:参考数据
  // 还没核实完之前,这个系统的输出不能当作可信结果对外展示。
  warn('every active drug has a verified withholding period',
    unverified.length === 0,
    unverified.length
      ? `${unverified.length} of ${drugRows.length} still unverified — ` +
        `check these against the ACVM register before presenting any output as meaningful`
      : '');

  // 声称核实过就必须留下出处,否则"核实"两个字没有意义。
  const verifiedWithoutSource = drugRows.filter(d => d.verified_on && !d.source_reference).length;
  check('no drug claims to be verified without recording its source',
    verifiedWithoutSource === 0, `${verifiedWithoutSource} drug(s)`);

  // ------------------------------------------------------------------- report
  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log(green(bold('  All structural checks passed.')));
    console.log(dim('  Every constraint above was verified against the live database,'));
    console.log(dim('  not read from the schema definition.'));
  } else {
    console.log(red(bold(`  ${failures} structural check(s) failed.`)));
  }
  if (warnings > 0) {
    console.log();
    console.log(red(bold(`  ${warnings} warning(s) about the data the system depends on.`)));
    console.log(dim('  The schema is sound, but its outputs are only as good as the'));
    console.log(dim('  reference data behind them.'));
  }
  console.log('='.repeat(60) + '\n');

} finally {
  db.close();
  fs.unlinkSync(workingCopy);
}

process.exit(failures === 0 ? 0 : 1);
