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
      window.location.assign(next && next.startsWith('/') ? next : '/');
    } catch (error) {
      result.hidden = false;
      result.innerHTML = `<div class="notice error">${String(error.message).replaceAll('<', '&lt;')}</div>`;
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
});
