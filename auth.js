const crypto = require('crypto');

const SESSION_COOKIE = 'calvinglog_session';
const SESSION_HOURS = 12;

function passwordFields(password, salt = crypto.randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must contain at least 8 characters');
  }
  return {
    password_salt: salt,
    password_hash: crypto.scryptSync(password, salt, 64).toString('hex')
  };
}

function safeEqualHex(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyPassword(password, user) {
  if (!user?.password_salt || !user?.password_hash || typeof password !== 'string') return false;
  const candidate = passwordFields(password, user.password_salt).password_hash;
  return safeEqualHex(candidate, user.password_hash);
}

function demoPasswordFor(role) {
  const envName = `CALVING_LOG_${String(role).toUpperCase()}_PASSWORD`;
  const configured = process.env[envName];
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${envName} is required in production`);
  }
  return `calving-${role}-2026`;
}

function ensureUserCredentials(db) {
  const defaults = [
    { name: 'Farm Owner', username: 'owner', role: 'owner' },
    { name: 'Farm Vet', username: 'vet', role: 'vet' },
    { name: 'Relief Milker', username: 'milker', role: 'milker' }
  ];
  const update = db.prepare(`
    UPDATE users
    SET username = ?, password_salt = ?, password_hash = ?
    WHERE id = ?
  `);

  db.transaction(() => {
    for (const account of defaults) {
      const user = db.prepare('SELECT * FROM users WHERE name = ?').get(account.name);
      if (!user) continue;
      // Environment passwords initialise a new database. Once credentials exist, a
      // password changed by the user must survive an application restart.
      if (user.username && user.password_salt && user.password_hash) continue;
      const expectedPassword = demoPasswordFor(account.role);
      const credentials = passwordFields(expectedPassword);
      update.run(account.username, credentials.password_salt, credentials.password_hash, user.id);
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id);
    }
  })();
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf('=');
    if (separator < 0) return [decodeURIComponent(part), ''];
    return [decodeURIComponent(part.slice(0, separator)), decodeURIComponent(part.slice(separator + 1))];
  }));
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString());
  db.prepare(`
    INSERT INTO auth_sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(tokenHash(token), userId, expiresAt);
  return { token, expiresAt };
}

function sessionUser(db, req) {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (!token) return null;
  return db.prepare(`
    SELECT users.id, users.name, users.username, users.role, auth_sessions.expires_at
    FROM auth_sessions
    JOIN users ON auth_sessions.user_id = users.id
    WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
  `).get(tokenHash(token), new Date().toISOString()) || null;
}

function requireAuth(db) {
  return (req, res, next) => {
    const user = sessionUser(db, req);
    if (!user) return res.status(401).json({ error: 'Sign in is required' });
    req.user = user;
    next();
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `This action requires: ${roles.join(' or ')}` });
    }
    next();
  };
}

function cookieHeader(token, secure = false) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; ` +
    `Max-Age=${SESSION_HOURS * 60 * 60}${secure ? '; Secure' : ''}`;
}

function clearCookieHeader(secure = false) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

module.exports = {
  SESSION_COOKIE,
  clearCookieHeader,
  cookieHeader,
  createSession,
  ensureUserCredentials,
  parseCookies,
  passwordFields,
  requireAuth,
  requireRole,
  sessionUser,
  tokenHash,
  verifyPassword
};
