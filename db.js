const Database = require('better-sqlite3');
const db = new Database('calving-log.db');

db.pragma('foreign_keys = ON');

// ---------- 1. users ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'milker'
      CHECK (role IN ('owner', 'milker', 'vet')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ---------- 2. cows ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS cows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_number TEXT NOT NULL UNIQUE,
    breed TEXT,
    birth_date TEXT,
    lactation_number INTEGER,
    status TEXT NOT NULL DEFAULT 'lactating'
      CHECK (status IN ('lactating', 'dry', 'culled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ---------- 3. drugs ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS drugs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_name TEXT NOT NULL UNIQUE,
    active_ingredient TEXT,
    milk_withdrawal_days INTEGER NOT NULL,
    meat_withdrawal_days INTEGER,
    calculation_basis TEXT NOT NULL DEFAULT 'treatment_date'
      CHECK (calculation_basis IN ('treatment_date', 'calving_date')),
    is_active INTEGER NOT NULL DEFAULT 1
  )
`);

// ---------- 4. scc_records ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS scc_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cow_id INTEGER NOT NULL REFERENCES cows(id),
    test_date TEXT NOT NULL,
    scc_value INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'herd_test'
      CHECK (source IN ('herd_test', 'rmt', 'inline', 'culture')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ---------- 5. health_events ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS health_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cow_id INTEGER NOT NULL REFERENCES cows(id),
    event_type TEXT NOT NULL
      CHECK (event_type IN ('calving', 'treatment', 'dry_off', 'calcium', 'other')),
    event_date TEXT NOT NULL,
    calving_date TEXT,
    drug_id INTEGER REFERENCES drugs(id),
    withdrawal_days_applied INTEGER,
    withdrawal_end_date TEXT,
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  )
`);

// ---------- 6. dry_off_decisions ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS dry_off_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cow_id INTEGER NOT NULL REFERENCES cows(id),
    season TEXT NOT NULL,
    decision TEXT NOT NULL
      CHECK (decision IN ('antibiotic_dct', 'teat_seal_only')),
    justification TEXT,
    supporting_scc_id INTEGER REFERENCES scc_records(id),
    decided_by INTEGER REFERENCES users(id),
    decided_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ---------- 初始数据(只在数据库为空时插入一次)----------
const needsSeed = db.prepare('SELECT COUNT(*) AS count FROM cows').get().count === 0;

if (needsSeed) {
  db.exec(`
    INSERT INTO users (name, role) VALUES
      ('Farm Owner', 'owner'),
      ('Relief Milker', 'milker'),
      ('Farm Vet', 'vet')
  `);

  db.exec(`
    INSERT INTO drugs (drug_name, active_ingredient, milk_withdrawal_days, meat_withdrawal_days, calculation_basis) VALUES
      ('Orbenin L.A.', 'Cloxacillin', 4, 7, 'treatment_date'),
      ('Mastalone', 'Oxytetracycline', 4, 7, 'treatment_date'),
      ('Penethaject', 'Procaine penicillin', 3, 10, 'treatment_date'),
      ('Cepravin Dry Cow', 'Cephalonium', 4, 28, 'calving_date'),
      ('Bovaclox DC Xtra', 'Cloxacillin / Ampicillin', 7, 28, 'calving_date'),
      ('Teatseal', 'Bismuth subnitrate', 0, 0, 'treatment_date')
  `);

  db.exec(`
    INSERT INTO cows (tag_number, breed, lactation_number, status) VALUES
      ('212', 'Friesian', 3, 'lactating'),
      ('105', 'Jersey', 1, 'lactating'),
      ('308', 'Kiwicross', 5, 'dry'),
      ('417', 'Friesian', 2, 'lactating')
  `);

  db.exec(`
    INSERT INTO scc_records (cow_id, test_date, scc_value, source) VALUES
      ((SELECT id FROM cows WHERE tag_number='212'), '2026-06-18', 187000, 'herd_test'),
      ((SELECT id FROM cows WHERE tag_number='105'), '2026-06-18', 94000,  'herd_test'),
      ((SELECT id FROM cows WHERE tag_number='308'), '2026-06-18', 312000, 'herd_test'),
      ((SELECT id FROM cows WHERE tag_number='417'), '2026-06-18', 121000, 'herd_test')
  `);

  db.exec(`
    INSERT INTO health_events
      (cow_id, event_type, event_date, calving_date, drug_id, withdrawal_days_applied, withdrawal_end_date, notes, created_by)
    VALUES
      ((SELECT id FROM cows WHERE tag_number='212'), 'treatment', '2026-07-18', NULL,
       (SELECT id FROM drugs WHERE drug_name='Orbenin L.A.'), 4, '2026-07-22',
       'Clinical mastitis, left front quarter', (SELECT id FROM users WHERE name='Farm Owner')),

      ((SELECT id FROM cows WHERE tag_number='105'), 'calving', '2026-07-10', NULL,
       NULL, NULL, NULL, 'Normal calving', (SELECT id FROM users WHERE name='Relief Milker')),

      ((SELECT id FROM cows WHERE tag_number='308'), 'dry_off', '2026-07-05', '2026-09-15',
       (SELECT id FROM drugs WHERE drug_name='Cepravin Dry Cow'), 4, '2026-09-19',
       'Dry cow therapy at drying off', (SELECT id FROM users WHERE name='Farm Vet')),

      ((SELECT id FROM cows WHERE tag_number='417'), 'calcium', '2026-07-22', NULL,
       NULL, NULL, NULL, 'Preventive calcium after calving', (SELECT id FROM users WHERE name='Farm Owner'))
  `);

  db.exec(`
    INSERT INTO dry_off_decisions (cow_id, season, decision, justification, supporting_scc_id, decided_by) VALUES
      ((SELECT id FROM cows WHERE tag_number='308'), '2026-27', 'antibiotic_dct',
       'Herd test SCC 312,000 exceeds 150,000 threshold',
       (SELECT id FROM scc_records WHERE cow_id=(SELECT id FROM cows WHERE tag_number='308')),
       (SELECT id FROM users WHERE name='Farm Vet')),

      ((SELECT id FROM cows WHERE tag_number='105'), '2026-27', 'teat_seal_only',
       'Herd test SCC 94,000 below 125,000 threshold for first lactation',
       (SELECT id FROM scc_records WHERE cow_id=(SELECT id FROM cows WHERE tag_number='105')),
       (SELECT id FROM users WHERE name='Farm Vet'))
  `);
}

module.exports = db;