const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrate } = require('./migrate');
const { seed } = require('./seed');
const { syncAcvmReferenceData } = require('./acvmReferenceData');
const { syncAdditionalAcvmReferenceData } = require('./acvmAdditionalReferenceData');
const { syncOctoberReferenceData, VERSION } = require('./acvmOctoberReferenceData');

function oldDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); migrate(db); seed(db);
  syncAcvmReferenceData(db); syncAdditionalAcvmReferenceData(db);
  return db;
}

test('October package adds exactly three verified products without rewriting existing clinical snapshots', () => {
  const db = oldDatabase();
  try {
    const history = db.prepare('SELECT * FROM health_events ORDER BY id').all();
    const corrections = db.prepare('SELECT * FROM withdrawal_corrections ORDER BY id').all();
    const result = syncOctoberReferenceData(db);
    assert.equal(result.products_added, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM drugs WHERE is_active = 1').get().count, 11);
    assert.deepEqual(db.prepare('SELECT * FROM health_events ORDER BY id').all(), history);
    assert.deepEqual(db.prepare('SELECT * FROM withdrawal_corrections ORDER BY id').all(), corrections);
    assert.equal(db.pragma('user_version', { simple: true }), 9);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});

test('repeated import does not duplicate products, reference evidence or regimen rules', () => {
  const db = oldDatabase();
  try {
    syncOctoberReferenceData(db);
    const tables = ['drugs', 'drug_reference_revisions', 'drug_withdrawal_rules', 'reference_data_imports'];
    const counts = () => tables.map(table => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    const before = counts();
    assert.equal(syncOctoberReferenceData(db).applied, false);
    assert.deepEqual(counts(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reference_data_imports WHERE version = ?').get(VERSION).count, 1);
  } finally { db.close(); }
});

test('conflicting product identities roll the entire package back', () => {
  const db = oldDatabase();
  try {
    const insert = db.prepare(`INSERT INTO drugs (drug_name, acvm_registration_no, is_active,
      milk_withdrawal_value, milk_withdrawal_unit, calculation_basis) VALUES (?, ?, 0, 1, 'days', 'treatment_date')`);
    insert.run('Orbenin Enduro', 'A-TEST-CONFLICT');
    insert.run('Different test product', 'A006036');
    const before = db.prepare('SELECT * FROM drugs ORDER BY id').all();
    assert.throws(() => syncOctoberReferenceData(db), /Reference import conflict/);
    assert.deepEqual(db.prepare('SELECT * FROM drugs ORDER BY id').all(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reference_data_imports WHERE version = ?').get(VERSION).count, 0);
  } finally { db.close(); }
});
