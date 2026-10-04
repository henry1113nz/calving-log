document.addEventListener('DOMContentLoaded', () => {
  const { badge, escapeHtml, jsonOptions, requestJson, setBusy, showNotice } = window.CalvingLog;
  const output = document.getElementById('ai-connection-status');
  const button = document.getElementById('ai-test-button');
  const consent = document.getElementById('ai-test-consent');
  let configured = false;
  let canTest = false;
  let busy = false;

  function updateButton() {
    button.disabled = busy || !configured || !canTest || !consent.checked;
  }

  function renderStatus(status) {
    configured = status.external_ai_available;
    canTest = status.can_test_connection;
    document.getElementById('ai-test-controls').hidden = !canTest;
    const connection = status.connection_test || { state: 'untested' };
    output.className = '';
    const state = !configured ? 'Local only' : connection.state === 'connected' ? 'Last test passed'
      : connection.state === 'failed' ? 'Last test failed' : 'Configured — not tested';
    const variant = !configured || connection.state === 'failed' ? 'warning'
      : connection.state === 'connected' ? 'success' : 'info';
    output.innerHTML = `${badge(state, variant)}
      <p><strong>${escapeHtml(status.provider)} · ${escapeHtml(status.model)}</strong></p>
      <p>${escapeHtml(configured ? connection.message || 'Run the fixed connection test to check the key, balance and response format.' : status.configuration_message)}</p>
      ${connection.checked_at ? `<p class="list-detail">Last test: ${escapeHtml(new Date(connection.checked_at).toLocaleString('en-NZ'))}${Number.isFinite(connection.latency_ms) ? ` · ${escapeHtml(connection.latency_ms)} ms` : ''}. This is a past check, not a guarantee of current availability.</p>` : ''}
      ${canTest ? '' : '<p class="notice info">Only a farm owner can run connection tests. Use Ask for normal queries.</p>'}`;
    const limits = status.limits;
    document.getElementById('ai-usage').innerHTML = limits
      ? `<p class="list-detail">External requests today: ${escapeHtml(limits.used_today)} / ${escapeHtml(limits.daily_requests)} across this running server · UTC day ${escapeHtml(limits.day_utc)}. Per-user limit: ${escapeHtml(limits.per_user_per_minute)} per minute. Counters reset on restart.</p>` : '';
    updateButton();
  }

  async function loadStatus() {
    try { renderStatus(await requestJson('/api/assistant/status')); }
    catch (error) {
      configured = false;
      output.className = 'notice error';
      output.textContent = error.message;
      updateButton();
    }
  }

  consent.addEventListener('change', updateButton);
  button.addEventListener('click', async () => {
    if (busy || !configured || !canTest || !consent.checked) return;
    busy = true;
    setBusy(button, true, 'Testing…');
    showNotice('#ai-test-notice', '');
    try {
      const result = await requestJson('/api/assistant/connection-test', jsonOptions('POST', { consent: true }));
      showNotice('#ai-test-notice', result.message, result.state === 'connected' ? 'success' : 'warning');
      consent.checked = false; // Each paid probe needs fresh agreement.
    } catch (error) {
      showNotice('#ai-test-notice', error.message, 'error');
    } finally {
      await loadStatus();
      busy = false;
      setBusy(button, false);
      updateButton();
    }
  });
  loadStatus();
});
