document.addEventListener('DOMContentLoaded', async () => {
  const {
    emptyState, escapeHtml, formatDate, humanize, jsonOptions, requestJson, setBusy, showNotice
  } = window.CalvingLog;

  const taskLabels = {
    find_hold: 'Find a milk hold',
    record_treatment: 'Record treatment',
    record_calving: 'Record calving',
    change_schedule: 'Change milking schedule',
    dry_off_review: 'Dry-off review',
    review_unknown: 'Review unknown date',
    ask_assistant: 'Ask in everyday language',
    overall_walkthrough: 'Whole walkthrough'
  };

  let currentUser = null;

  function renderResults(rows) {
    const summary = document.getElementById('feedback-summary');
    const list = document.getElementById('feedback-list');
    list.className = '';
    if (!rows.length) {
      summary.innerHTML = '';
      list.innerHTML = emptyState('No field feedback yet', 'Ask a participant to complete one suggested task, then use the form above.');
      return;
    }

    const completedAlone = rows.filter(row => row.completion_status === 'completed').length;
    const average = rows.reduce((total, row) => total + row.ease_rating, 0) / rows.length;
    summary.innerHTML = `
      <div class="feedback-summary">
        <div><strong>${rows.length}</strong><span>responses</span></div>
        <div><strong>${average.toFixed(1)}/5</strong><span>average ease</span></div>
        <div><strong>${Math.round((completedAlone / rows.length) * 100)}%</strong><span>completed without help</span></div>
      </div>`;

    list.innerHTML = `<ul class="list">${rows.map(row => `
      <li class="list-row">
        <div class="list-main">
          <p class="list-title">${escapeHtml(taskLabels[row.task_code] || humanize(row.task_code))} · ${escapeHtml(row.ease_rating)}/5</p>
          <div class="list-meta">
            <span>${escapeHtml(row.submitted_by_name)} · ${escapeHtml(humanize(row.submitted_by_role))}</span>
            <span>${escapeHtml(humanize(row.completion_status))}</span>
            <span>${escapeHtml(formatDate(row.created_at.slice(0, 10), { short: true }))}</span>
          </div>
          ${row.confusing_part ? `<p class="list-detail"><strong>Confusing:</strong> ${escapeHtml(row.confusing_part)}</p>` : ''}
          ${row.suggestion ? `<p class="list-detail"><strong>Suggestion:</strong> ${escapeHtml(row.suggestion)}</p>` : ''}
        </div>
      </li>`).join('')}</ul>`;
  }

  async function loadOwnerResults() {
    if (currentUser?.role !== 'owner') return;
    document.getElementById('feedback-results').hidden = false;
    try {
      renderResults(await requestJson('/api/feedback'));
    } catch (error) {
      document.getElementById('feedback-list').innerHTML = emptyState('Unable to load feedback', error.message);
    }
  }

  try {
    currentUser = await requestJson('/api/auth/me');
    await loadOwnerResults();
  } catch {
    return;
  }

  document.getElementById('feedback-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('submit-feedback');
    // event.currentTarget 在 await 之后就变成 null,保存成功却会抛错,参与者看到的是
    // 一条红色的 JavaScript 报错而不是"已保存"——然后他们会重复提交。
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.ease_rating = Number(payload.ease_rating);

    setBusy(button, true, 'Submitting…');
    showNotice('#feedback-notice', '');
    try {
      await requestJson('/api/feedback', jsonOptions('POST', payload));
      form.reset();
      showNotice('#feedback-notice', 'Thank you. Your feedback was saved for the next design review.', 'success');
      await loadOwnerResults();
    } catch (error) {
      showNotice('#feedback-notice', error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  });
});
