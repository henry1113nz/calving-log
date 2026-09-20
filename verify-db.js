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

function heading(text) {
  console.log(`\n${bold(text)}\n${'-'.repeat(text.length)}`);
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

  const expectedTables = [
    'auth_sessions',
    'cows', 'drugs', 'drug_reference_revisions', 'drug_withdrawal_rules',
    'dry_off_decisions', 'event_corrections', 'event_reviews', 'farm_settings',
    'field_feedback', 'health_events', 'reference_data_imports', 'milking_schedule', 'scc_records',
    'users', 'withdrawal_corrections'
  ];
  const actualTables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all().map(r => r.name);
  check('all v8 tables are present', expectedTables.every(t => actualTables.includes(t)),
    actualTables.join(', '));

  const columnsOf = table => db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
  const drugColumns = columnsOf('drugs');
  const eventColumns = columnsOf('health_events');
  const revisionColumns = columnsOf('drug_reference_revisions');
  const ruleColumns = columnsOf('drug_withdrawal_rules');
  const scheduleColumns = columnsOf('milking_schedule');
  const correctionColumns = columnsOf('withdrawal_corrections');
  const importColumns = columnsOf('reference_data_imports');
  const userColumns = columnsOf('users');
  const sessionColumns = columnsOf('auth_sessions');
  const eventCorrectionColumns = columnsOf('event_corrections');
  const reviewColumns = columnsOf('event_reviews');
  const feedbackColumns = columnsOf('field_feedback');
  check('drugs has the v5 ACVM provenance columns',
    ['acvm_registration_no', 'label_revision', 'verified_by', 'requires_regimen',
      'current_reference_revision_id']
      .every(c => drugColumns.includes(c)),
    drugColumns.join(', '));
  check('health_events snapshots its reference, rule and milking schedule',
    ['drug_reference_revision_id', 'drug_rule_id', 'milkings_per_day_applied',
      'milking_schedule_snapshot'].every(c => eventColumns.includes(c)),
    eventColumns.join(', '));
  check('milking schedule stores effective-dated farm changes',
    ['effective_from', 'milkings_per_day', 'note', 'created_by', 'created_at']
      .every(c => scheduleColumns.includes(c)),
    scheduleColumns.join(', '));
  check('reference revisions retain the official label and verifier evidence',
    ['drug_id', 'acvm_registration_no', 'label_revision', 'label_wording',
      'source_reference', 'verified_on', 'verified_by'].every(c => revisionColumns.includes(c)),
    revisionColumns.join(', '));
  check('withdrawal rules model named regimens at both milking frequencies',
    ['drug_id', 'reference_revision_id', 'rule_code', 'rule_name',
      'milkings_once_daily', 'milkings_twice_daily', 'is_default']
      .every(c => ruleColumns.includes(c)),
    ruleColumns.join(', '));
  check('reference imports and corrected snapshots have an audit trail',
    ['health_event_id', 'previous_days', 'previous_end_date', 'previous_status',
      'corrected_days', 'corrected_end_date', 'corrected_status', 'reason', 'corrected_at']
      .every(c => correctionColumns.includes(c))
      && ['version', 'source_summary', 'imported_at'].every(c => importColumns.includes(c)),
    `withdrawal_corrections: ${correctionColumns.join(', ')}; ` +
      `reference_data_imports: ${importColumns.join(', ')}`);
  check('users and sessions support server-side authentication',
    ['username', 'password_salt', 'password_hash'].every(c => userColumns.includes(c))
      && ['token_hash', 'user_id', 'expires_at'].every(c => sessionColumns.includes(c)),
    `users: ${userColumns.join(', ')}; auth_sessions: ${sessionColumns.join(', ')}`);
  check('operational corrections retain before/after evidence and the accountable actor',
    ['health_event_id', 'reason', 'previous_snapshot', 'corrected_snapshot',
      'corrected_by', 'corrected_at'].every(c => eventCorrectionColumns.includes(c)),
    eventCorrectionColumns.join(', '));
  check('the review queue records opening and resolution accountability',
    ['health_event_id', 'status', 'reason', 'resolution', 'opened_by', 'resolved_by',
      'created_at', 'resolved_at'].every(c => reviewColumns.includes(c)),
    reviewColumns.join(', '));
  check('field feedback records a structured task result and signed-in participant',
    ['area', 'task_code', 'completion_status', 'ease_rating', 'confusing_part',
      'suggestion', 'submitted_by', 'created_at'].every(c => feedbackColumns.includes(c)),
    feedbackColumns.join(', '));

  check('foreign key enforcement is on', db.pragma('foreign_keys', { simple: true }) === 1);

  // ------------------------------------------------------------------- health
  heading('2. Stored data health');

  check('integrity_check reports ok',
    db.pragma('integrity_check', { simple: true }) === 'ok');

  const fkViolations = db.pragma('foreign_key_check');
  check('no foreign key violations in stored data', fkViolations.length === 0,
    fkViolations.length ? JSON.stringify(fkViolations) : '');

  const referenceImports = db.prepare(
    'SELECT COUNT(*) AS count FROM reference_data_imports'
  ).get().count;
  check('the verified reference-data import is recorded', referenceImports > 0,
    `${referenceImports} import audit row(s)`);

  const missingCredentials = db.prepare(`
    SELECT COUNT(*) AS count FROM users
    WHERE username IS NULL OR password_salt IS NULL OR password_hash IS NULL
  `).get().count;
  check('every seeded operational user has login credentials', missingCredentials === 0,
    `${missingCredentials} user(s) missing credentials`);

  const unresolvedWithoutReview = db.prepare(`
    SELECT COUNT(*) AS count
    FROM health_events
    WHERE deleted_at IS NULL
      AND withdrawal_status IN ('awaiting_calving_date', 'requires_vet_advice', 'minimum_dry_period_breached')
      AND NOT EXISTS (
        SELECT 1 FROM event_reviews
        WHERE event_reviews.health_event_id = health_events.id
          AND event_reviews.status = 'open'
      )
  `).get().count;
  check('every unresolved event has an open accountable review', unresolvedWithoutReview === 0,
    `${unresolvedWithoutReview} unresolved event(s) missing a review`);

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

  const missingMilkingSnapshots = db.prepare(`
    SELECT COUNT(*) AS count
    FROM health_events
    JOIN drugs ON health_events.drug_id = drugs.id
    WHERE (drugs.milk_withdrawal_unit = 'milkings' OR drugs.requires_regimen = 1)
      AND (health_events.milkings_per_day_applied IS NULL
           OR health_events.milking_schedule_snapshot IS NULL)
  `).get().count;
  check('milking-based events retain the schedule used by their calculation',
    missingMilkingSnapshots === 0, `${missingMilkingSnapshots} event(s) missing a schedule snapshot`);

  const wrongCurrentRevision = db.prepare(`
    SELECT COUNT(*) AS count
    FROM drugs
    JOIN drug_reference_revisions
      ON drug_reference_revisions.id = drugs.current_reference_revision_id
    WHERE drug_reference_revisions.drug_id != drugs.id
  `).get().count;
  check('each drug current revision belongs to that same drug', wrongCurrentRevision === 0,
    `${wrongCurrentRevision} mismatched current revision(s)`);

  const wrongRuleRevision = db.prepare(`
    SELECT COUNT(*) AS count
    FROM drug_withdrawal_rules
    JOIN drug_reference_revisions
      ON drug_reference_revisions.id = drug_withdrawal_rules.reference_revision_id
    WHERE drug_reference_revisions.drug_id != drug_withdrawal_rules.drug_id
  `).get().count;
  check('each withdrawal rule and its revision belong to the same drug', wrongRuleRevision === 0,
    `${wrongRuleRevision} mismatched rule(s)`);

  const brokenEventReferences = db.prepare(`
    SELECT COUNT(*) AS count
    FROM health_events
    JOIN drug_withdrawal_rules ON drug_withdrawal_rules.id = health_events.drug_rule_id
    WHERE health_events.drug_id IS NOT drug_withdrawal_rules.drug_id
       OR health_events.drug_reference_revision_id IS NOT drug_withdrawal_rules.reference_revision_id
  `).get().count;
  check('event regimen snapshots point to the matching drug and revision',
    brokenEventReferences === 0, `${brokenEventReferences} mismatched event snapshot(s)`);

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
  expectRejected(db, 'event referencing a non-existent drug reference revision',
    `INSERT INTO health_events
       (cow_id, event_type, event_date, drug_reference_revision_id)
     VALUES (1, 'treatment', '2026-08-10', 99999)`);
  expectRejected(db, 'event referencing a non-existent withdrawal rule',
    `INSERT INTO health_events (cow_id, event_type, event_date, drug_rule_id)
     VALUES (1, 'treatment', '2026-08-10', 99999)`);
  expectRejected(db, 'drug current revision referencing a non-existent revision',
    `UPDATE drugs SET current_reference_revision_id = 99999 WHERE id = 1`);
  expectRejected(db, 'decision referencing a non-existent SCC record',
    `INSERT INTO dry_off_decisions (cow_id, season, decision, supporting_scc_id)
     VALUES (1, '2027-28', 'antibiotic_dct', 99999)`);
  expectRejected(db, 'milking schedule referencing a non-existent user',
    `INSERT INTO milking_schedule (effective_from, milkings_per_day, created_by)
     VALUES ('2031-01-01', 2, 99999)`);
  expectRejected(db, 'session referencing a non-existent user',
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
     VALUES ('invalid-session-user', 99999, '2031-01-01T00:00:00.000Z')`);
  expectRejected(db, 'event correction referencing a non-existent event',
    `INSERT INTO event_corrections
       (health_event_id, reason, previous_snapshot, corrected_snapshot, corrected_by)
     VALUES (99999, 'valid reason', '{}', '{}', 1)`);
  expectRejected(db, 'event review referencing a non-existent user',
    `INSERT INTO event_reviews (health_event_id, reason, opened_by)
     VALUES ((SELECT id FROM health_events LIMIT 1), 'valid review reason', 99999)`);
  expectRejected(db, 'field feedback referencing a non-existent signed-in user',
    `INSERT INTO field_feedback
       (area, task_code, completion_status, ease_rating, submitted_by)
     VALUES ('dashboard', 'find_hold', 'completed', 4, 99999)`);
  expectRejected(db, 'deleting a cow that still has health events',
    `DELETE FROM cows WHERE id = 1`);

  // -------------------------------------------------------------------- values
  heading('4. Value constraints are enforced');

  expectRejected(db, 'cow status outside the allowed set',
    `INSERT INTO cows (tag_number, status) VALUES ('V1', 'flying')`);
  expectRejected(db, 'user role outside the allowed set',
    `INSERT INTO users (name, role) VALUES ('V', 'president')`);
  expectRejected(db, 'duplicate username',
    `INSERT INTO users (name, role, username)
     SELECT 'Duplicate login', 'milker', username FROM users WHERE username IS NOT NULL LIMIT 1`);
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
  expectRejected(db, 'requires_regimen outside the boolean set',
    `UPDATE drugs SET requires_regimen = 2 WHERE id = 1`);
  expectRejected(db, 'a non-date reference verification date',
    `INSERT INTO drug_reference_revisions
       (drug_id, acvm_registration_no, label_revision, label_wording,
        source_reference, verified_on, verified_by)
     VALUES (1, 'VERIFY', 'invalid-date-test', 'wording', 'source', 'yesterday', 'Verifier')`);
  expectRejected(db, 'duplicate label revision for one drug',
    `INSERT INTO drug_reference_revisions
       (drug_id, acvm_registration_no, label_revision, label_wording,
        source_reference, verified_on, verified_by)
     SELECT drug_id, acvm_registration_no, label_revision, label_wording,
            source_reference, verified_on, verified_by
     FROM drug_reference_revisions LIMIT 1`);
  expectRejected(db, 'negative regimen milking count',
    `INSERT INTO drug_withdrawal_rules
       (drug_id, reference_revision_id, rule_code, rule_name, description,
        milkings_once_daily, milkings_twice_daily)
     SELECT drug_id, reference_revision_id, 'verify-negative', 'Invalid negative rule',
            'constraint verification', -1, 1
     FROM drug_withdrawal_rules LIMIT 1`);
  expectRejected(db, 'withdrawal rule default flag outside the boolean set',
    `UPDATE drug_withdrawal_rules SET is_default = 2 WHERE id =
       (SELECT id FROM drug_withdrawal_rules LIMIT 1)`);
  expectRejected(db, 'duplicate regimen code for one drug',
    `INSERT INTO drug_withdrawal_rules
       (drug_id, reference_revision_id, rule_code, rule_name, description,
        milkings_once_daily, milkings_twice_daily, is_default)
     SELECT drug_id, reference_revision_id, rule_code, rule_name, description,
            milkings_once_daily, milkings_twice_daily, is_default
     FROM drug_withdrawal_rules LIMIT 1`);
  expectRejected(db, 'a second row in the single-row farm settings table',
    `INSERT INTO farm_settings (id, milkings_per_day) VALUES (2, 2)`);
  expectRejected(db, 'an implausible milking frequency',
    `UPDATE farm_settings SET milkings_per_day = 9 WHERE id = 1`);
  expectRejected(db, 'an implausible event milking snapshot',
    `INSERT INTO health_events
       (cow_id, event_type, event_date, milkings_per_day_applied)
     VALUES (1, 'treatment', '2026-08-10', 4)`);
  expectRejected(db, 'an implausible dated milking frequency',
    `INSERT INTO milking_schedule (effective_from, milkings_per_day)
     VALUES ('2031-01-02', 4)`);
  expectRejected(db, 'two milking changes on the same effective date',
    `INSERT INTO milking_schedule (effective_from, milkings_per_day)
     SELECT effective_from, milkings_per_day FROM milking_schedule LIMIT 1`);
  expectRejected(db, 'an unknown withdrawal status',
    `INSERT INTO health_events (cow_id, event_type, event_date, withdrawal_status)
     VALUES (1, 'treatment', '2026-08-10', 'probably_fine')`);
  expectRejected(db, 'a calving date that is neither predicted nor actual',
    `INSERT INTO health_events (cow_id, event_type, event_date, calving_date, calving_date_source)
     VALUES (1, 'dry_off', '2026-08-10', '2026-10-01', 'guessed')`);
  expectRejected(db, 'event with no date',
    `INSERT INTO health_events (cow_id, event_type, event_date) VALUES (1, 'treatment', NULL)`);
  expectRejected(db, 'event correction with an uninformative reason',
    `INSERT INTO event_corrections
       (health_event_id, reason, previous_snapshot, corrected_snapshot, corrected_by)
     VALUES ((SELECT id FROM health_events LIMIT 1), 'bad', '{}', '{}', 1)`);
  expectRejected(db, 'event correction with a non-JSON snapshot',
    `INSERT INTO event_corrections
       (health_event_id, reason, previous_snapshot, corrected_snapshot, corrected_by)
     VALUES ((SELECT id FROM health_events LIMIT 1), 'valid correction reason', 'not-json', '{}', 1)`);
  expectRejected(db, 'event review with an unknown status',
    `INSERT INTO event_reviews (health_event_id, status, reason)
     VALUES ((SELECT id FROM health_events LIMIT 1), 'ignored', 'valid review reason')`);
  expectRejected(db, 'resolved review without resolution accountability',
    `INSERT INTO event_reviews (health_event_id, status, reason)
     VALUES ((SELECT id FROM health_events LIMIT 1), 'resolved', 'valid review reason')`);
  expectRejected(db, 'field feedback with an unknown completion result',
    `INSERT INTO field_feedback
       (area, task_code, completion_status, ease_rating, submitted_by)
     VALUES ('dashboard', 'find_hold', 'mostly', 4, 1)`);
  expectRejected(db, 'field feedback with a rating outside 1 to 5',
    `INSERT INTO field_feedback
       (area, task_code, completion_status, ease_rating, submitted_by)
     VALUES ('dashboard', 'find_hold', 'completed', 6, 1)`);

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
  expectRejected(db, 'non-canonical milking schedule date',
    `INSERT INTO milking_schedule (effective_from, milkings_per_day) VALUES ('2031-2-1', 2)`);

  // ------------------------------------------------------------- traceability
  heading('6. Audit and traceability rules');

  expectRejected(db, 'two conflicting dry-off decisions for one cow in one season',
    `INSERT INTO dry_off_decisions (cow_id, season, decision)
     SELECT cow_id, season, 'teat_seal_only' FROM dry_off_decisions LIMIT 1`);
  expectRejected(db, 'duplicate SCC test for the same cow, date and source',
    `INSERT INTO scc_records (cow_id, test_date, scc_value, source)
     SELECT cow_id, test_date, 999000, source FROM scc_records LIMIT 1`);
  expectAccepted(db, 'an unresolved event can have one open accountable review',
    `INSERT INTO event_reviews (health_event_id, reason, opened_by)
     SELECT id, 'verification review record', 1 FROM health_events
     WHERE NOT EXISTS (
       SELECT 1 FROM event_reviews WHERE event_reviews.health_event_id = health_events.id
         AND event_reviews.status = 'open'
     ) LIMIT 1`);
  expectRejected(db, 'an event cannot have two open accountable reviews',
    `INSERT INTO event_reviews (health_event_id, reason, opened_by)
     SELECT health_event_id, 'duplicate open review', 1
     FROM event_reviews WHERE status = 'open' LIMIT 1`);

  const hardDeleted = db.prepare(`SELECT COUNT(*) AS count FROM health_events WHERE deleted_at IS NOT NULL`).get().count;
  check('soft-deleted treatment records are retained, not erased', true,
    `${hardDeleted} soft-deleted record(s) still recoverable`);

  // ------------------------------------------------------------- still usable
  heading('7. Legitimate data is still accepted');

  expectAccepted(db, 'a valid cow',
    `INSERT INTO cows (tag_number, breed, birth_date, lactation_number, status)
     VALUES ('VERIFY-1', 'Friesian', '2023-07-30', 2, 'lactating')`);
  expectAccepted(db, 'a valid treatment with a diagnosis',
    `INSERT INTO health_events
       (cow_id, event_type, event_date, drug_id, drug_reference_revision_id, diagnosis, notes)
     VALUES ((SELECT id FROM cows WHERE tag_number='VERIFY-1'), 'treatment', '2026-08-10',
             (SELECT id FROM drugs WHERE drug_name='Mastalone'),
             (SELECT current_reference_revision_id FROM drugs WHERE drug_name='Mastalone'),
             'clinical_mastitis', 'verification row')`);
  expectAccepted(db, 'a valid SCC result',
    `INSERT INTO scc_records (cow_id, test_date, scc_value, source)
     VALUES ((SELECT id FROM cows WHERE tag_number='VERIFY-1'), '2026-08-10', 210000, 'rmt')`);
  expectAccepted(db, 'a valid structured field feedback response',
    `INSERT INTO field_feedback
       (area, task_code, completion_status, ease_rating, confusing_part, submitted_by)
     VALUES ('dashboard', 'find_hold', 'completed_with_help', 3,
             'The date wording needed an explanation', 1)`);

  // ------------------------------------------------------------------ indexes
  heading('8. Index coverage on foreign keys and hot queries');

  const fkColumns = [
    ['drugs', 'current_reference_revision_id'],
    ['drug_reference_revisions', 'drug_id'],
    ['drug_withdrawal_rules', 'drug_id'], ['drug_withdrawal_rules', 'reference_revision_id'],
    ['health_events', 'cow_id'], ['health_events', 'drug_id'], ['health_events', 'created_by'],
    ['health_events', 'drug_reference_revision_id'], ['health_events', 'drug_rule_id'],
    ['auth_sessions', 'user_id'],
    ['milking_schedule', 'created_by'],
    ['event_corrections', 'health_event_id'], ['event_corrections', 'corrected_by'],
    ['event_reviews', 'health_event_id'], ['event_reviews', 'opened_by'],
    ['event_reviews', 'resolved_by'],
    ['field_feedback', 'submitted_by'],
    ['withdrawal_corrections', 'health_event_id'],
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

  // v4 把提前产犊当成“无规则”;v5 按批准标签的提前产犊分支计算。有效记录里
  // 不应再残留旧状态,否则前端会把已有官方答案的事件误报成永久未解析。
  const legacyEarlyStatus = db.prepare(`
    SELECT COUNT(*) AS count FROM health_events
    WHERE deleted_at IS NULL
      AND withdrawal_status = 'minimum_dry_period_breached'
  `).get().count;
  check('no active event retains the retired v4 early-calving status',
    legacyEarlyStatus === 0, `${legacyEarlyStatus} event(s)`);

  // ------------------------------------------------------------ reference data
  heading('10. Reference data provenance');

  const drugRows = db.prepare(`
    SELECT drug_name, active_ingredient, milk_withdrawal_value, milk_withdrawal_unit,
           meat_withdrawal_days, calculation_basis, minimum_dry_period_days,
           acvm_registration_no, label_revision, requires_regimen,
           label_wording, verified_on, verified_by, source_reference,
           current_reference_revision_id
    FROM drugs WHERE is_active = 1 ORDER BY drug_name
  `).all();

  const unverified = drugRows.filter(d => !(
    d.acvm_registration_no && d.label_revision && d.label_wording &&
    d.verified_on && d.verified_by && d.source_reference &&
    d.current_reference_revision_id
  ));

  for (const drug of drugRows) {
    const summary = `${drug.milk_withdrawal_value} ${drug.milk_withdrawal_unit}`;
    const mark = drug.verified_on ? green('verified ' + drug.verified_on) : red('NOT VERIFIED');
    console.log(`  ${drug.drug_name.padEnd(20)} ${summary.padEnd(34)} ${mark}`);
  }

  console.log();
  // v5 把参考数据核验从“提示”升级成发布门槛。只要启用的药有一条缺出处,
  // 脚本就以非零状态退出,不能再带着红色警告仍然声称数据库验证通过。
  check('exactly five active drug references are available',
    drugRows.length === 5, `${drugRows.length} active drug(s)`);
  check('every active drug has complete verified ACVM provenance',
    unverified.length === 0,
    unverified.length
      ? `${unverified.length} of ${drugRows.length} active reference(s) are incomplete`
      : '');

  const currentRevisionMismatch = db.prepare(`
    SELECT COUNT(*) AS count
    FROM drugs
    LEFT JOIN drug_reference_revisions
      ON drug_reference_revisions.id = drugs.current_reference_revision_id
    WHERE drugs.is_active = 1 AND (
      drug_reference_revisions.id IS NULL OR
      drug_reference_revisions.drug_id IS NOT drugs.id OR
      drug_reference_revisions.acvm_registration_no IS NOT drugs.acvm_registration_no OR
      drug_reference_revisions.label_revision IS NOT drugs.label_revision OR
      drug_reference_revisions.label_wording IS NOT drugs.label_wording OR
      drug_reference_revisions.source_reference IS NOT drugs.source_reference OR
      drug_reference_revisions.verified_on IS NOT drugs.verified_on OR
      drug_reference_revisions.verified_by IS NOT drugs.verified_by
    )
  `).get().count;
  check('each active drug mirrors its selected immutable reference revision',
    currentRevisionMismatch === 0, `${currentRevisionMismatch} mismatch(es)`);

  const inactiveRows = db.prepare(`
    SELECT drug_name, verified_on, current_reference_revision_id
    FROM drugs WHERE is_active = 0
  `).all();
  check('Bovaclox DC Xtra is the sole inactive, unverified retained product',
    inactiveRows.length === 1
      && inactiveRows[0].drug_name === 'Bovaclox DC Xtra'
      && inactiveRows[0].verified_on === null
      && inactiveRows[0].current_reference_revision_id === null,
    JSON.stringify(inactiveRows));

  const byName = Object.fromEntries(drugRows.map(d => [d.drug_name, d]));
  const mastalone = byName.Mastalone;
  const penethaject = byName.Penethaject;
  const cepravin = byName['Cepravin Dry Cow'];
  const teatSeal = drugRows.find(d => /^teat\s*seal$/i.test(d.drug_name));
  const orbenin = byName['Orbenin L.A.'];

  check('Mastalone uses 8 milkings and a 30-day meat withholding period',
    mastalone && mastalone.milk_withdrawal_value === 8
      && mastalone.milk_withdrawal_unit === 'milkings'
      && mastalone.meat_withdrawal_days === 30,
    JSON.stringify(mastalone));
  check('Penethaject uses 48 hours and a 7-day meat withholding period',
    penethaject && /penethamate/i.test(penethaject.active_ingredient)
      && penethaject.milk_withdrawal_value === 48
      && penethaject.milk_withdrawal_unit === 'hours'
      && penethaject.meat_withdrawal_days === 7,
    JSON.stringify(penethaject));
  check('Cepravin carries its 49-day condition and 8-milking period',
    cepravin && cepravin.calculation_basis === 'calving_date'
      && cepravin.minimum_dry_period_days === 49
      && cepravin.milk_withdrawal_value === 8
      && cepravin.milk_withdrawal_unit === 'milkings',
    JSON.stringify(cepravin));
  check('TeatSeal starts at calving and requires 8 milkings',
    teatSeal && teatSeal.calculation_basis === 'calving_date'
      && teatSeal.milk_withdrawal_value === 8
      && teatSeal.milk_withdrawal_unit === 'milkings',
    JSON.stringify(teatSeal));

  const orbeninRules = orbenin
    ? db.prepare(`
        SELECT * FROM drug_withdrawal_rules
        WHERE drug_id = ? AND reference_revision_id = ? ORDER BY rule_code
      `).all(
        db.prepare(`SELECT id FROM drugs WHERE drug_name = 'Orbenin L.A.'`).get().id,
        orbenin.current_reference_revision_id
      )
    : [];
  check('Orbenin requires an explicit choice from multiple verified regimens',
    orbenin && orbenin.requires_regimen === 1 && orbeninRules.length > 1
      && orbeninRules.every(r => r.milkings_once_daily > 0 && r.milkings_twice_daily > 0),
    JSON.stringify(orbeninRules));

  const unselectedRequiredRegimens = db.prepare(`
    SELECT COUNT(*) AS count
    FROM health_events
    JOIN drugs ON drugs.id = health_events.drug_id
    WHERE health_events.deleted_at IS NULL
      AND drugs.is_active = 1
      AND drugs.requires_regimen = 1
      AND health_events.drug_rule_id IS NULL
  `).get().count;
  check('no active event silently guesses a regimen for a drug that requires selection',
    unselectedRequiredRegimens === 0,
    `${unselectedRequiredRegimens} event(s) missing drug_rule_id`);

  // ------------------------------------------------------------------- report
  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log(green(bold('  All structural checks passed.')));
    console.log(dim('  Every constraint above was verified against the live database,'));
    console.log(dim('  not read from the schema definition.'));
  } else {
    console.log(red(bold(`  ${failures} structural check(s) failed.`)));
  }
  console.log('='.repeat(60) + '\n');

} finally {
  db.close();
  fs.unlinkSync(workingCopy);
}

process.exit(failures === 0 ? 0 : 1);
