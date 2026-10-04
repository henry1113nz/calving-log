document.addEventListener('DOMContentLoaded', async () => {
  const {
    badge, emptyState, escapeHtml, formatDate, humanize, jsonOptions,
    requestJson, setBusy, showNotice
  } = window.CalvingLog;
  const identity = document.getElementById('account-identity');

  let signedInUser = null;
  try {
    signedInUser = await requestJson('/api/auth/me');
    identity.className = 'identity-panel';
    identity.innerHTML = `<strong>${escapeHtml(signedInUser.name)}</strong><br>${escapeHtml(signedInUser.username)} · ${escapeHtml(humanize(signedInUser.role))}`;
  } catch (error) {
    identity.className = 'notice error';
    identity.textContent = error.message;
  }

  document.getElementById('password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById('password-submit');
    if (button.disabled) return;
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

  // Separate sign-ins keep medicine verification and history correction owner-controlled.
  const peopleCard = document.getElementById('people-card');
  const peopleList = document.getElementById('people-list');
  if (!signedInUser || signedInUser.role !== 'owner') return;
  document.getElementById('account-ai-card').hidden = false;
  peopleCard.hidden = false;

  async function loadPeople() {
    try {
      const users = await requestJson('/api/users');
      peopleList.className = '';
      peopleList.innerHTML = users.length
        ? `<ul class="list">${users.map(user => `
            <li class="list-row">
              <div class="list-main">
                <p class="list-title">${escapeHtml(user.name)}</p>
                <p class="list-detail">${escapeHtml(user.username || 'No sign-in yet')} · added ${escapeHtml(formatDate(String(user.created_at).slice(0, 10), { short: true }))}</p>
              </div>
              ${badge(humanize(user.role), user.role === 'owner' ? 'warning' : 'info')}
              ${badge(user.is_active ? 'Active' : 'Disabled', user.is_active ? 'success' : 'danger')}
            </li>`).join('')}</ul>`
        : emptyState('No sign-ins yet', 'Create one for each trial participant.');
      const select = document.getElementById('access-user');
      const selected = select.value;
      select.innerHTML = '<option value="">Choose an account</option>' + users.filter(user => user.id !== signedInUser.id)
        .map(user => `<option value="${user.id}">${escapeHtml(user.username)} · ${user.is_active ? 'active' : 'disabled'}</option>`).join('');
      select.value = users.some(user => String(user.id) === selected) ? selected : '';
    } catch (error) {
      peopleList.className = 'notice error';
      peopleList.textContent = error.message;
    }
  }

  document.getElementById('people-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById('people-submit');
    if (button.disabled) return;
    setBusy(button, true, 'Creating…');
    try {
      const created = await requestJson('/api/users', jsonOptions('POST', {
        name: document.getElementById('person-name').value.trim(),
        username: document.getElementById('person-username').value.trim(),
        role: document.getElementById('person-role').value,
        password: document.getElementById('person-password').value
      }));
      form.reset();
      showNotice('#people-notice',
        `${created.name} can now sign in as ${created.username}. Ask them to change the password on this page.`,
        'success');
      await loadPeople();
    } catch (error) {
      showNotice('#people-notice', error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  });

  const action = document.getElementById('access-action');
  action.addEventListener('change', () => {
    const reset = action.value === 'reset_password';
    document.getElementById('access-temporary-field').hidden = !reset;
    document.getElementById('access-temporary-password').required = reset;
    if (!reset) document.getElementById('access-temporary-password').value = '';
  });
  async function loadActions() {
    const target = document.getElementById('account-actions');
    try {
      const actions = await requestJson('/api/account-actions');
      target.className = '';
      target.innerHTML = actions.length ? `<ul class="list">${actions.map(row => `<li class="list-row"><div class="list-main"><p class="list-title">${escapeHtml(humanize(row.action))} · ${escapeHtml(row.target_username)}</p><p class="list-detail">${escapeHtml(row.reason)}</p><p class="hint">By ${escapeHtml(row.actor_username)} · ${escapeHtml(window.CalvingLog.formatTimestamp(row.created_at))}</p></div></li>`).join('')}</ul>` : emptyState('No account changes yet', 'The latest 50 owner actions will appear here.');
    } catch (error) { target.className = 'notice error'; target.textContent = error.message; }
  }
  document.getElementById('access-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById('access-submit');
    if (button.disabled) return;
    const userId = document.getElementById('access-user').value;
    if (!userId) return;
    setBusy(button, true, 'Updating…');
    try {
      const result = await requestJson(`/api/users/${encodeURIComponent(userId)}/access`, jsonOptions('POST', {
        action: action.value, current_password: document.getElementById('access-owner-password').value,
        temporary_password: document.getElementById('access-temporary-password').value,
        reason: document.getElementById('access-reason').value.trim()
      }));
      form.reset();
      document.getElementById('access-temporary-field').hidden = true;
      document.getElementById('access-temporary-password').required = false;
      showNotice('#access-notice', result.message, 'success');
      await Promise.all([loadPeople(), loadActions()]);
    } catch (error) { showNotice('#access-notice', error.message, 'error'); }
    finally { setBusy(button, false); }
  });

  await loadPeople();
  await loadActions();
});
