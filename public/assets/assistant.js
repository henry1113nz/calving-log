document.addEventListener('DOMContentLoaded', () => {
  const {
    badge, emptyState, escapeHtml, formatDate, humanize, jsonOptions,
    requestJson, setBusy, showNotice
  } = window.CalvingLog;

  const form = document.getElementById('assistant-form');
  const result = document.getElementById('assistant-result');

  function renderAnswer(payload) {
    result.className = '';
    if (!payload.supported) {
      result.innerHTML = emptyState('Question not supported yet', payload.message);
      return;
    }

    const modeLabel = payload.assistant_mode === 'openai'
      ? 'External AI intent'
      : payload.assistant_mode === 'local_fallback'
        ? 'Local fallback intent'
        : 'Local constrained intent';
    const rows = payload.rows || [];
    result.innerHTML = `
      <div class="notice info"><strong>${escapeHtml(payload.message)}</strong><br>
        ${badge(modeLabel, 'info')} ${badge('Database result', 'success')}
      </div>
      ${rows.length ? `<ul class="list" style="margin-top:14px">${rows.map(row => {
        const unresolved = row.requires_attention || !row.withdrawal_end_date;
        return `<li class="list-row hold-row${unresolved ? ' urgent' : ''}">
          <div class="list-main">
            <p class="list-title">Cow ${escapeHtml(row.tag_number)} · ${escapeHtml(row.drug_name || humanize(row.event_type))}</p>
            <p class="list-detail">${unresolved
              ? 'No authoritative eligible date. Human review is required.'
              : `Hold through ${escapeHtml(formatDate(row.withdrawal_end_date, { short: true }))}; earliest eligible ${escapeHtml(formatDate(row.eligible_from_date, { short: true }))} if no other hold applies.`}</p>
            ${(row.warnings || []).length ? `<ul class="warning-list">${row.warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
          </div>
          ${unresolved ? badge('Hold', 'danger') : badge(row.is_estimate ? 'Predicted' : 'Calculated', row.is_estimate ? 'warning' : 'success')}
        </li>`;
      }).join('')}</ul>` : emptyState('No medicine holds are listed today', 'Other animal-health and farm holds must still be checked.')}`;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('assistant-submit');
    setBusy(button, true, 'Checking…');
    showNotice('#assistant-notice', '');
    try {
      const payload = await requestJson('/api/assistant/query', jsonOptions('POST', {
        question: document.getElementById('assistant-question').value.trim()
      }));
      renderAnswer(payload);
      if (payload.notice) showNotice('#assistant-notice', payload.notice, 'info');
    } catch (error) {
      showNotice('#assistant-notice', error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  });
});
