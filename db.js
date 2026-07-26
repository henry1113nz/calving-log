const Database = require('better-sqlite3');
const db = new Database('calving-log.db');

// 开启外键约束(SQLite 默认关闭,必须手动打开)
db.pragma('foreign_keys = ON');

// 表1:cows —— 牛只本身的信息
db.exec(`
  CREATE TABLE IF NOT EXISTS cows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_number TEXT NOT NULL UNIQUE,
    breed TEXT,
    status TEXT NOT NULL DEFAULT 'lactating'
      CHECK (status IN ('lactating', 'dry', 'culled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 表2:drugs —— 药物字典
db.exec(`
  CREATE TABLE IF NOT EXISTS drugs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_name TEXT NOT NULL UNIQUE,
    milk_withdrawal_days INTEGER NOT NULL,
    meat_withdrawal_days INTEGER,
    calculation_basis TEXT NOT NULL DEFAULT 'treatment_date'
      CHECK (calculation_basis IN ('treatment_date', 'calving_date'))
  )
`);

// 表3:health_events —— 健康事件(用 cow_id 关联到 cows 表)
db.exec(`
  CREATE TABLE IF NOT EXISTS health_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cow_id INTEGER NOT NULL REFERENCES cows(id),
    event_type TEXT NOT NULL,
    event_date TEXT NOT NULL,
    calving_date TEXT,
    drug_id INTEGER REFERENCES drugs(id),
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 初始药物数据
db.exec(`
  INSERT OR IGNORE INTO drugs (drug_name, milk_withdrawal_days, meat_withdrawal_days, calculation_basis) VALUES
    ('Orbenin L.A.', 4, 7, 'treatment_date'),
    ('Cepravin Dry Cow', 4, 28, 'calving_date')
`);

module.exports = db;