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

  // 试用期间参与者需要自己的登录,否则只能共用 owner 密码——那等于把核验药品、
  // 改挤奶计划和更正历史的权限一起交出去,而这些正是系统里最不该随手改的东西。
  const peopleCard = document.getElementById('people-card');
  const peopleList = document.getElementById('people-list');
  if (!signedInUser || signedInUser.role !== 'owner') return;
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
            </li>`).join('')}</ul>`
        : emptyState('No sign-ins yet', 'Create one for each trial participant.');
    } catch (error) {
      peopleList.className = 'notice error';
      peopleList.textContent = error.message;
    }
  }

  document.getElementById('people-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById('people-submit');
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

  await loadPeople();
});
