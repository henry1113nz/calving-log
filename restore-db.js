#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const backupArg = process.argv[2];
const destinationArg = process.argv[3];

if (!backupArg || !destinationArg) {
  console.error('Usage: node restore-db.js <verified-backup.db> <new-destination.db>');
  console.error('The destination must not exist; this command never overwrites a live database.');
  process.exit(1);
}

const backup = path.resolve(backupArg);
const destination = path.resolve(destinationArg);

if (!fs.existsSync(backup)) {
  console.error(`Backup not found: ${backup}`);
  process.exit(1);
}
if (fs.existsSync(destination)) {
  console.error(`Refusing to overwrite an existing database: ${destination}`);
  process.exit(1);
}

const source = new Database(backup, { readonly: true, fileMustExist: true });
const integrity = source.pragma('integrity_check', { simple: true });
source.close();
if (integrity !== 'ok') {
  console.error(`Backup failed integrity_check: ${integrity}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(backup, destination, fs.constants.COPYFILE_EXCL);
console.log(`Verified restore candidate created: ${destination}`);
console.log('Run verify-db against this file, stop the service, then point CALVING_LOG_DB to it.');
