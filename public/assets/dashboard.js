document.addEventListener('DOMContentLoaded', async () => {
  const {
    badge, emptyState, escapeHtml, formatDate, humanize, requestJson
  } = window.CalvingLog;

  function dayAfter(value) {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }

  function renderVat(rows) {
    const target = document.getElementById('vat-list');
    target.className = '';
    if (!rows.length) {
      target.innerHTML = emptyState('No medicine holds are listed today', 'Still check all other animal-health and farm instructions before milk enters the vat.');
      return;
    }

    target.innerHTML = `<ul class="list">${rows.map(row => {
      const attention = Boolean(row.requires_attention || !row.withdrawal_end_date);
      const warnings = Array.isArray(row.warnings) ? row.warnings : [];
      const dateBlock = attention
        ? `<div class="hold-date">${badge('Hold', 'danger')}<span>No eligible date yet</span></div>`
        : `<div class="hold-date"><strong>Hold through ${escapeHtml(formatDate(row.withdrawal_end_date, { short: true }))}</strong><span>Earliest eligible ${escapeHtml(formatDate(row.eligible_from_date, { short: true }))}</span></div>`;
      return `
        <li class="list-row hold-row${attention ? ' urgent' : ''}">
          <div class="list-main">
            <p class="list-title">Cow ${escapeHtml(row.tag_number)} · ${escapeHtml(row.drug_name || humanize(row.event_type))}</p>
            <div class="list-meta">
              <span>${escapeHtml(formatDate(row.event_date, { short: true }))}</span>
              ${row.is_estimate ? badge('Predicted', 'warning') : badge(humanize(row.withdrawal_status), attention ? 'danger' : 'success')}
            </div>
            ${warnings.length ? `<ul class="warning-list">${warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}
          </div>
          ${dateBlock}
        </li>`;
    }).join('')}</ul>`;
  }

  function renderEvents(rows) {
    const target = document.getElementById('recent-events');
    target.className = '';
    const recent = rows.slice(0, 5);
    if (!recent.length) {
      target.innerHTML = emptyState('No events recorded');
      return;
    }
    target.innerHTML = `<ul class="list">${recent.map(row => `
      <li class="list-row">
        <div class="list-main">
          <p class="list-title">Cow ${escapeHtml(row.tag_number)} · ${escapeHtml(humanize(row.event_type))}</p>
          <div class="list-meta"><span>${escapeHtml(formatDate(row.event_date, { short: true }))}</span>${row.drug_name ? `<span>${escapeHtml(row.drug_name)}</span>` : ''}</div>
          ${row.withdrawal_end_date ? `<p class="list-detail">Hold through ${escapeHtml(formatDate(row.withdrawal_end_date, { short: true }))}; earliest eligible ${escapeHtml(formatDate(dayAfter(row.withdrawal_end_date), { short: true }))} if no other hold applies.</p>` : ''}
        </div>
      </li>`).join('')}</ul>`;
  }

  try {
    const [vat, events, cows, references, schedule] = await Promise.all([
      requestJson('/api/vat-exclusions'),
      requestJson('/api/events'),
      requestJson('/api/cows'),
      requestJson('/api/drugs/reference-status'),
      requestJson('/api/milking-schedule')
    ]);

    const needsReview = vat.filter(row => row.requires_attention || !row.withdrawal_end_date).length;
    const activeHerd = cows.filter(cow => cow.status !== 'culled').length;
    const currentEntry = schedule.entries.find(entry => entry.effective_from <= schedule.today);

    document.getElementById('hero-hold-count').textContent = vat.length;
    document.getElementById('hero-title').textContent = vat.length
      ? `${vat.length} cow${vat.length === 1 ? '' : 's'} must stay out of the vat.`
      : 'The vat list is clear today.';
    document.getElementById('hero-copy').textContent = needsReview
      ? `${needsReview} record${needsReview === 1 ? ' needs' : 's need'} a person to confirm the clear date before milk can be accepted.`
      : 'Every active medicine hold has a calculated date. Predicted dates remain marked, and other farm holds must still be checked.';
    document.getElementById('stat-review').textContent = needsReview;
    document.getElementById('stat-milkings').textContent = `${schedule.current_milkings_per_day}× / day`;
    document.getElementById('stat-milkings-foot').textContent = currentEntry
      ? `Effective since ${formatDate(currentEntry.effective_from, { short: true })}`
      : 'Fallback farm setting';
    document.getElementById('stat-herd').textContent = activeHerd;
    document.getElementById('stat-acvm').textContent = `${references.verified_active_count}/${references.active_count}`;

    renderVat(vat);
    renderEvents(events);
  } catch (error) {
    document.getElementById('hero-title').textContent = 'Dashboard data could not be loaded.';
    document.getElementById('hero-copy').textContent = error.message;
    document.getElementById('vat-list').innerHTML = emptyState('Unable to load milk holds', error.message);
    document.getElementById('recent-events').innerHTML = emptyState('Unable to load events', error.message);
  }
});
