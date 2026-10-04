// Browser-side defences complement authentication; they are not a security audit.
function webSecurity(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  else res.setHeader('Cache-Control', 'no-cache');

  if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    const expected = `${req.protocol}://${req.get('host')}`;
    if ((origin && origin !== expected) || req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'Cross-site changes are not allowed. Open CalvingLog directly and try again.' });
    }
  }
  next();
}

module.exports = { webSecurity };
