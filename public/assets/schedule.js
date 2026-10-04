document.addEventListener('DOMContentLoaded', async () => {
  const { badge, escapeHtml, formatDate, humanize, jsonOptions, requestJson, setBusy, showNotice, today } = window.CalvingLog;
  const form = document.getElementById('milking-schedule-form');
  document.getElementById('effective_from').value = today();
  async function load() {
    const data = await requestJson('/api/milking-schedule');
    document.getElementById('current-frequency').textContent = `Current: ${data.current_milkings_per_day}× per day`;
    const target = document.getElementById('schedule-list'); target.className = '';
    target.innerHTML = `<ol class="timeline">${data.entries.map(entry => `<li class="timeline-item${entry.effective_from > data.today ? ' future' : ''}"><span class="timeline-dot"></span><div class="timeline-copy"><strong>${escapeHtml(formatDate(entry.effective_from))} · ${entry.milkings_per_day}× daily</strong>${badge(entry.effective_from > data.today ? 'Upcoming' : 'Effective from this date')}<p>${escapeHtml(entry.note || '')} ${escapeHtml(entry.created_by_name || '')}</p></div></li>`).join('')}</ol>`;
  }
  try {
    const user = await requestJson('/api/auth/me');
    document.getElementById('schedule-identity').textContent = `${user.name} · ${humanize(user.role)}`;
    if (user.role !== 'owner') { form.querySelectorAll('input,select,textarea,button').forEach(item => { item.disabled = true; }); showNotice('#schedule-result', 'You can read the plan. Only an owner can add schedule changes.', 'info'); }
    await load();
  } catch(error) { showNotice('#schedule-result', error.message, 'error'); }
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('button'); setBusy(button, true);
    try {
      await requestJson('/api/milking-schedule', jsonOptions('POST', { effective_from: document.getElementById('effective_from').value, milkings_per_day: Number(document.getElementById('schedule_milkings_per_day').value), note: document.getElementById('schedule_note').value.trim() || null }));
      form.reset(); document.getElementById('effective_from').value = today(); await load(); showNotice('#schedule-result', 'Dated change saved. Review any existing holds affected by an operational change.', 'success');
    } catch(error) { showNotice('#schedule-result', error.message, 'error'); } finally { setBusy(button, false); }
  });
});
