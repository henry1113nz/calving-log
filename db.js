const Database = require('better-sqlite3');
const db = new Database('calving-log.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS health_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cow_number TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_date TEXT NOT NULL,
    notes TEXT
  )
`);

module.exports = db;