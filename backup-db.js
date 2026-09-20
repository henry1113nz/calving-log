#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const source = path.resolve(process.env.CALVING_LOG_DB || 'calving-log.db');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.resolve(process.argv[2] || path.join('backups', `calving-log-${stamp}.db`));

if (!fs.existsSync(source)) {
  console.error(`Source database not found: ${source}`);
  process.exit(1);
}
if (fs.existsSync(destination)) {
  console.error(`Refusing to overwrite an existing backup: ${destination}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
const db = new Database(source, { readonly: true, fileMustExist: true });

db.backup(destination)
  .then(() => {
    const copy = new Database(destination, { readonly: true, fileMustExist: true });
    const integrity = copy.pragma('integrity_check', { simple: true });
    copy.close();
    if (integrity !== 'ok') throw new Error(`Backup integrity_check returned: ${integrity}`);
    console.log(`Verified backup created: ${destination}`);
  })
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
