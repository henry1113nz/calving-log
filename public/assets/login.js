document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  const result = document.getElementById('login-result');
  const params = new URLSearchParams(window.location.search);

  if (params.get('reason') === 'session') {
    result.hidden = false;
    result.innerHTML = '<div class="notice warning">Your sign-in is missing or has expired. Sign in again to continue.</div>';
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Sign in failed');
      const next = params.get('next');
      // A protocol-relative URL (//example.com) is not an internal destination.
      const destination = next ? new URL(next, window.location.origin) : null;
      window.location.assign(next?.startsWith('/') && destination?.origin === window.location.origin
        ? destination.pathname + destination.search + destination.hash : '/');
    } catch (error) {
      result.hidden = false;
      result.innerHTML = `<div class="notice error">${String(error.message).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')}</div>`;
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
});
