document.addEventListener('DOMContentLoaded', () => {
  const {
    badge, emptyState, escapeHtml, formatDate, humanize, jsonOptions,
    requestJson, setBusy, showNotice, today
  } = window.CalvingLog;
  const state = { schedule: null, references: null, user: null };
  document.getElementById('effective_from').value = today();

  function renderSchedule() {
    const schedule = state.schedule;
    const target = document.getElementById('schedule-list');
    target.className = '';
    document.getElementById('medicine-current-milkings').textContent = `${schedule.current_milkings_per_day}× / day`;
    const current = schedule.entries
      .filter(entry => entry.effective_from <= schedule.today)
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
    document.getElementById('medicine-current-since').textContent = current
      ? `Effective since ${formatDate(current.effective_from, { short: true })}`
      : 'Farm fallback';

    if (!schedule.entries.length) {
      target.innerHTML = emptyState('No dated milking schedule');
      return;
    }
    target.innerHTML = `<ol class="timeline">${schedule.entries.map(entry => {
      const future = entry.effective_from > schedule.today;
      const isCurrent = current?.id === entry.id;
      return `
        <li class="timeline-item${future ? ' future' : ''}">
          <span class="timeline-dot" aria-hidden="true"></span>
          <div class="timeline-copy">
            <strong>${escapeHtml(formatDate(entry.effective_from))} · ${entry.milkings_per_day} milking${entry.milkings_per_day === 1 ? '' : 's'} per day</strong>
            <div style="margin-top:4px">${isCurrent ? badge('Current', 'success') : future ? badge('Upcoming', 'warning') : badge('Historical')}</div>
            <p>${escapeHtml(entry.note || 'No operational note')}${entry.created_by_name ? ` · recorded by ${escapeHtml(entry.created_by_name)}` : ''}</p>
          </div>
        </li>`;
    }).join('')}</ol>`;
  }

  function renderReferences() {
    const data = state.references;
    document.getElementById('medicine-verified').textContent = `${data.verified_active_count}/${data.active_count}`;
    document.getElementById('medicine-unverified').textContent = data.unverified_active_count;
    document.getElementById('medicine-inactive').textContent = data.inactive_count;
    showNotice(
      '#reference-summary',
      data.unverified_active_count
        ? `${data.unverified_active_count} active product reference(s) are incomplete. The release gate will fail.`
        : 'Every active medicine has complete ACVM provenance. Inactive records remain visible but cannot be selected for treatment.',
      data.unverified_active_count ? 'error' : 'success'
    );

    const target = document.getElementById('medicine-list');
    target.className = '';
    target.innerHTML = `<div class="medicine-grid">${data.drugs.map(drug => {
      const verified = Boolean(drug.is_verified);
      const inactive = !drug.is_active;
      const status = inactive
        ? badge('Inactive', 'warning')
        : verified ? badge('Verified', 'success') : badge('Unverified', 'danger');
      const withdrawal = drug.requires_regimen
        ? `${drug.rule_count} labelled regimen options`
        : `${drug.milk_withdrawal_value ?? '—'} ${drug.milk_withdrawal_unit || ''}`;
      return `
        <article class="medicine-card${inactive ? ' inactive' : ''}">
          <div class="medicine-head"><div><h3 class="medicine-name">${escapeHtml(drug.drug_name)}</h3><div class="list-meta"><span>${escapeHtml(drug.active_ingredient || 'Ingredient not recorded')}</span></div></div>${status}</div>
          <dl class="medicine-meta">
            <dt>ACVM</dt><dd>${escapeHtml(drug.acvm_registration_no || 'No current registration reference')}</dd>
            <dt>Milk WHP</dt><dd>${escapeHtml(withdrawal)}</dd>
            <dt>Basis</dt><dd>${escapeHtml(humanize(drug.calculation_basis))}</dd>
            <dt>Meat WHP</dt><dd>${drug.meat_withdrawal_days === null ? 'Not recorded' : `${escapeHtml(drug.meat_withdrawal_days)} day(s)`}</dd>
            <dt>Label</dt><dd>${escapeHtml(drug.label_revision || 'No current approved label available')}</dd>
            <dt>Checked</dt><dd>${drug.verified_on ? `${escapeHtml(formatDate(drug.verified_on))} · ${escapeHtml(drug.verified_by || '')}` : 'Not verified'}</dd>
          </dl>
          <details class="medicine-label"><summary>Label wording and source</summary><p>${escapeHtml(drug.label_wording || 'No current approved label wording is stored.')}</p>${drug.source_reference?.startsWith('http') ? `<a href="${escapeHtml(drug.source_reference)}" target="_blank" rel="noreferrer">Open source reference</a>` : `<p>${escapeHtml(drug.source_reference || 'No source reference')}</p>`}</details>
        </article>`;
    }).join('')}</div>`;
  }

  async function loadData() {
    try {
      const [schedule, references, user] = await Promise.all([
        requestJson('/api/milking-schedule'),
        requestJson('/api/drugs/reference-status'),
        requestJson('/api/auth/me')
      ]);
      Object.assign(state, { schedule, references, user });
      document.getElementById('schedule-identity').textContent = `${user.name} · ${humanize(user.role)} (recorded automatically)`;
      const canEditSchedule = user.role === 'owner';
      document.querySelectorAll('#milking-schedule-form input, #milking-schedule-form select, #milking-schedule-form textarea, #milking-schedule-form button')
        .forEach(control => { control.disabled = !canEditSchedule; });
      if (!canEditSchedule) {
        showNotice('#schedule-result', 'Owner access is required to change the milking schedule.', 'info');
      }
      renderSchedule();
      renderReferences();
    } catch (error) {
      document.getElementById('schedule-list').innerHTML = emptyState('Unable to load schedule', error.message);
      document.getElementById('medicine-list').innerHTML = emptyState('Unable to load medicine references', error.message);
    }
  }

  document.getElementById('milking-schedule-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const payload = {
      effective_from: document.getElementById('effective_from').value,
      milkings_per_day: Number(document.getElementById('schedule_milkings_per_day').value),
      note: document.getElementById('schedule_note').value.trim() || null
    };
    setBusy(submit, true, 'Adding change…');
    try {
      await requestJson('/api/milking-schedule', jsonOptions('POST', payload));
      showNotice('#schedule-result', `Milking change added from ${formatDate(payload.effective_from)}. Existing event snapshots were not rewritten.`, 'success');
      form.reset();
      document.getElementById('effective_from').value = today();
      await loadData();
    } catch (error) {
      showNotice('#schedule-result', error.message, 'error');
    } finally {
      setBusy(submit, false);
    }
  });

  loadData();
});
