document.addEventListener('DOMContentLoaded', async () => {
  const { escapeHtml, humanize, jsonOptions, requestJson, setBusy, showNotice } = window.CalvingLog;
  const identity = document.getElementById('account-identity');

  try {
    const user = await requestJson('/api/auth/me');
    identity.className = 'identity-panel';
    identity.innerHTML = `<strong>${escapeHtml(user.name)}</strong><br>${escapeHtml(user.username)} · ${escapeHtml(humanize(user.role))}`;
  } catch (error) {
    identity.className = 'notice error';
    identity.textContent = error.message;
  }

  document.getElementById('password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById('password-submit');
    const next = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-password').value;
    if (next !== confirm) {
      showNotice('#password-notice', 'The two new-password entries do not match.', 'error');
      return;
    }

    setBusy(button, true, 'Changing…');
    try {
      const payload = await requestJson('/api/auth/change-password', jsonOptions('POST', {
        current_password: document.getElementById('current-password').value,
        new_password: next
      }));
      form.reset();
      showNotice('#password-notice', payload.message, 'success');
    } catch (error) {
      showNotice('#password-notice', error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  });
});
