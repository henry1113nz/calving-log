const fs = require('node:fs');
const Database = require('better-sqlite3');

function backupBeforeMigration(db, databasePath, latestVersion) {
  const version = db.pragma('user_version', { simple: true });
  if (version >= latestVersion) return null;
  const destination = `${databasePath}.backup-before-v${latestVersion}-${Date.now()}-${process.pid}`;
  if (fs.existsSync(destination)) throw new Error('Migration backup destination already exists; refusing to overwrite it.');
  // INTO writes a consistent separate snapshot, never rewrites the source database.
  db.prepare('VACUUM INTO ?').run(destination);
  const copy = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    if (copy.pragma('integrity_check', { simple: true }) !== 'ok'
      || copy.pragma('user_version', { simple: true }) !== version) {
      throw new Error('Pre-migration backup verification failed. Database upgrade has not started.');
    }
  } finally { copy.close(); }
  return destination;
}

module.exports = { backupBeforeMigration };
