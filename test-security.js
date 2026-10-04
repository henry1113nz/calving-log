const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrate } = require('./migrate');
const { backupBeforeMigration } = require('./migrationBackup');
const { parseCookies, passwordFields, verifyPassword } = require('./auth');
const { webSecurity } = require('./webSecurity');

function request({ origin, site, method = 'POST', path = '/api/events', secure = true } = {}) {
  const headers = { host: 'calving.example', origin, 'sec-fetch-site': site };
  const req = { method, path, secure, protocol: secure ? 'https' : 'http', get: name => headers[name.toLowerCase()] };
  const result = { headers: {}, proceeded: false };
  const res = { setHeader: (name, value) => { result.headers[name] = value; }, status: value => { result.status = value; return res; }, json: value => { result.body = value; } };
  webSecurity(req, res, () => { result.proceeded = true; });
  return result;
}

test('short, oversized or non-string passwords fail verification without exceptions', () => {
  const user = passwordFields('a-test-password-2026');
  for (const password of ['', 'short', null, 12, 'x'.repeat(257)]) assert.equal(verifyPassword(password, user), false);
  assert.equal(verifyPassword('a-test-password-2026', user), true);
});
test('malformed cookies do not crash authentication or shadow a valid session', () => {
  const cookies = parseCookies('broken=%E0%A4%A; calvinglog_session=valid; calvinglog_session=duplicate; __proto__=test');
  assert.equal(cookies.calvinglog_session, 'valid');
  assert.equal(cookies.broken, undefined);
  assert.equal(Object.getPrototypeOf(cookies), Object.prototype);
});
test('cross-origin writes and cross-site browser writes are rejected', () => {
  for (const values of [{ origin: 'https://evil.example' }, { origin: 'null' }, { site: 'cross-site' }]) {
    const result = request(values);
    assert.equal(result.status, 403); assert.equal(result.proceeded, false);
  }
});
test('same-origin and authenticated non-browser clients remain supported', () => {
  for (const values of [{ origin: 'https://calving.example', site: 'same-origin' }, {}]) assert.equal(request(values).proceeded, true);
});
test('API responses cannot be cached, framed or used as script; HTTPS enables HSTS', () => {
  const result = request();
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['X-Frame-Options'], 'DENY');
  assert.match(result.headers['Content-Security-Policy'], /script-src 'self'/);
  assert.match(result.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.ok(result.headers['Strict-Transport-Security']);
  assert.equal(request({ secure: false }).headers['Strict-Transport-Security'], undefined);
  assert.equal(request({ method: 'GET', path: '/assistant.html' }).headers['Cache-Control'], 'no-cache');
});
test('v9 access migration retains existing user IDs and creates constrained audit history', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, role TEXT);
      CREATE TABLE drugs (id INTEGER PRIMARY KEY, current_reference_revision_id INTEGER);
      INSERT INTO users VALUES (42, 'Existing operator', 'owner'); PRAGMA user_version = 9;`);
    migrate(db);
    assert.equal(db.pragma('user_version', { simple: true }), 10);
    assert.deepEqual(db.prepare('SELECT * FROM users').get(), { id: 42, name: 'Existing operator', role: 'owner', is_active: 1 });
    assert.throws(() => db.prepare('UPDATE users SET is_active = 4').run());
    assert.throws(() => db.prepare("INSERT INTO account_actions (user_id, action, reason, performed_by) VALUES (42, 'delete', 'testing', 42)").run());
    assert.throws(() => db.prepare("INSERT INTO account_actions (user_id, action, reason, performed_by) VALUES (999, 'disable', 'testing', 42)").run());
    assert.deepEqual(migrate(db).applied, []);
  } finally { db.close(); }
});
test('pre-migration snapshot is valid, preserves old rows and is skipped after upgrading', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calving-migration-backup-'));
  const source = path.join(directory, 'source.db');
  const db = new Database(source);
  let snapshot;
  try {
    db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES (1, 'preserved'); PRAGMA user_version=9;");
    snapshot = backupBeforeMigration(db, source, 10);
    db.exec("UPDATE sample SET value='changed'; PRAGMA user_version=10;");
    const copy = new Database(snapshot, { readonly: true });
    try {
      assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(copy.pragma('user_version', { simple: true }), 9);
      assert.equal(copy.prepare('SELECT value FROM sample').get().value, 'preserved');
    } finally { copy.close(); }
    assert.equal(backupBeforeMigration(db, source, 10), null);
  } finally {
    db.close();
    for (const file of [source, snapshot].filter(Boolean)) fs.rmSync(file, { force: true });
    fs.rmdirSync(directory);
  }
});
test('a failed pre-migration backup does not change the source database', () => {
  const db = new Database(':memory:');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calving-migration-failure-'));
  try {
    db.pragma('user_version = 9');
    assert.throws(() => backupBeforeMigration(db, path.join(directory, 'missing', 'source.db'), 10));
    assert.equal(db.pragma('user_version', { simple: true }), 9);
  } finally { db.close(); fs.rmdirSync(directory); }
});
