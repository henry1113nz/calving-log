document.addEventListener('DOMContentLoaded', () => {
  const {
    badge, emptyState, escapeHtml, formatDate, humanize, jsonOptions,
    populateSelect, requestJson, setBusy, showNotice, today
  } = window.CalvingLog;

  const state = { cows: [], drugs: [], events: [], schedule: null, user: null };
  const form = document.getElementById('event-form');
  const drugSelect = document.getElementById('drug_id');
  const regimenField = document.getElementById('regimen-field');
  const regimenSelect = document.getElementById('drug_rule_id');
  const calvingInput = document.getElementById('calving_date');
  const calvingSource = document.getElementById('calving_date_source');

  document.getElementById('event_date').value = today();

  function selectedDrug() {
    return state.drugs.find(drug => drug.id === Number(drugSelect.value)) || null;
  }

  function scheduleAt(date) {
    if (!state.schedule || !date) return null;
    return state.schedule.entries
      .filter(entry => entry.effective_from <= date)
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] || null;
  }

  function updateScheduleHint() {
    const drug = selectedDrug();
    const eventDate = document.getElementById('event_date').value;
    const basisDate = drug?.calculation_basis === 'calving_date'
      ? (calvingInput.value || eventDate)
      : eventDate;
    const entry = scheduleAt(basisDate);
    const override = document.getElementById('milkings_per_day').value;
    const hint = document.getElementById('schedule-hint');
    hint.textContent = override
      ? `Exception recorded: ${override} milking(s) per day will be frozen with this event.`
      : entry
        ? `Schedule resolves to ${entry.milkings_per_day} milking(s) per day from ${formatDate(entry.effective_from, { short: true })}; the dated schedule is frozen with this event.`
        : 'No dated schedule applies to this date; the farm fallback will be used.';
  }

  function updateDrugPreview() {
    const drug = selectedDrug();
    const target = document.getElementById('drug-preview');
    regimenField.hidden = true;
    regimenSelect.required = false;
    regimenSelect.innerHTML = '<option value="">Select the regimen used</option>';
    document.getElementById('regimen-description').textContent = '';
    calvingInput.required = false;

    if (!drug) {
      target.className = 'empty-state';
      target.innerHTML = '<strong>No medicine selected</strong><span>Non-treatment events can be saved without a medicine.</span>';
      updateScheduleHint();
      return;
    }

    if (drug.requires_regimen) {
      regimenField.hidden = false;
      regimenSelect.required = true;
      for (const rule of drug.rules || []) {
        const option = document.createElement('option');
        option.value = rule.id;
        option.textContent = rule.rule_name;
        option.dataset.description = rule.description;
        regimenSelect.appendChild(option);
      }
    }

    const tags = [
      badge('ACVM verified', 'success'),
      badge(drug.calculation_basis === 'calving_date' ? 'From calving' : 'From treatment', 'info'),
      drug.requires_regimen ? badge('Regimen required', 'warning') : ''
    ].join('');
    target.className = 'notice info';
    target.innerHTML = `
      <div>${tags}</div>
      <p style="margin:10px 0 4px"><strong>${escapeHtml(drug.drug_name)}</strong> · ${escapeHtml(drug.withdrawal_summary)}</p>
      <p style="margin:0;color:#4b6175">${escapeHtml(drug.label_revision || 'Current verified label')} · ${escapeHtml(drug.acvm_registration_no || '')}</p>
      ${drug.minimum_dry_period_days ? `<p style="margin:8px 0 0"><strong>Early-calving branch:</strong> ${escapeHtml(drug.minimum_dry_period_days)} days from treatment plus the labelled milkings.</p>` : ''}`;
    updateScheduleHint();
  }

  function updateCalvingSourceState() {
    const isCalvingEvent = document.getElementById('event_type').value === 'calving';
    if (isCalvingEvent) calvingSource.value = 'actual';
    calvingSource.disabled = isCalvingEvent;
  }

  function statusBadge(event) {
    const status = event.withdrawal_status;
    if (status === 'calculated') return badge('Calculated', 'success');
    if (status === 'not_applicable') return badge('No withholding');
    if (status === 'awaiting_calving_date') return badge('Awaiting calving', 'warning');
    return badge(humanize(status), 'danger');
  }

  function filteredEvents() {
    const search = document.getElementById('event-search').value.trim().toLowerCase();
    const type = document.getElementById('event-filter').value;
    return state.events.filter(event => {
      const haystack = `${event.tag_number} ${event.drug_name || ''} ${event.notes || ''}`.toLowerCase();
      return (!search || haystack.includes(search)) && (!type || event.event_type === type);
    });
  }

  function renderEvents() {
    const target = document.getElementById('event-list');
    target.className = '';
    const rows = filteredEvents();
    if (!rows.length) {
      target.innerHTML = emptyState('No matching events', 'Change the filters or record a new event.');
      return;
    }
    const canCorrect = ['owner', 'vet'].includes(state.user?.role);
    target.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Date / cow</th><th>Event</th><th>Calculation</th><th>Recorded by</th><th></th></tr></thead>
        <tbody>${rows.map(event => `
          <tr>
            <td><strong>${escapeHtml(formatDate(event.event_date, { short: true }))}</strong><br><span class="list-detail">Cow ${escapeHtml(event.tag_number)}</span></td>
            <td><strong>${escapeHtml(humanize(event.event_type))}</strong>${event.drug_name ? `<br><span class="list-detail">${escapeHtml(event.drug_name)}${event.drug_rule_name ? ` · ${escapeHtml(event.drug_rule_name)}` : ''}</span>` : ''}${event.diagnosis ? `<br><span class="list-detail">${escapeHtml(humanize(event.diagnosis))}</span>` : ''}</td>
            <td>${statusBadge(event)}${event.withdrawal_end_date ? `<br><span class="list-detail">Clear ${escapeHtml(formatDate(event.withdrawal_end_date, { short: true }))}</span>` : ''}${event.milkings_per_day_applied ? `<br><span class="list-detail">${escapeHtml(event.milkings_per_day_applied)}× milking snapshot</span>` : ''}</td>
            <td>${escapeHtml(event.created_by_name || 'Not recorded')}${event.notes ? `<br><span class="list-detail">${escapeHtml(event.notes)}</span>` : ''}</td>
            <td><div class="list-actions">${canCorrect ? `<button class="btn secondary small edit-event" data-id="${event.id}" type="button">Correct</button>` : ''}<button class="btn secondary small history-event" data-id="${event.id}" type="button">History</button>${canCorrect ? `<button class="btn danger small delete-event" data-id="${event.id}" type="button">Delete</button>` : ''}</div></td>
          </tr>`).join('')}</tbody>
      </table></div>`;

    target.querySelectorAll('.delete-event').forEach(button => {
      button.addEventListener('click', async () => {
        if (!window.confirm('Soft-delete this event? The audit record will be retained.')) return;
        setBusy(button, true, 'Deleting…');
        try {
          await requestJson(`/api/events/${button.dataset.id}`, { method: 'DELETE' });
          await loadEvents();
        } catch (error) {
          window.alert(error.message);
          setBusy(button, false);
        }
      });
    });
    target.querySelectorAll('.edit-event').forEach(button => {
      button.addEventListener('click', () => startEdit(Number(button.dataset.id)));
    });
    target.querySelectorAll('.history-event').forEach(button => {
      button.addEventListener('click', () => showCorrectionHistory(Number(button.dataset.id)));
    });
  }

  function resetForm() {
    form.reset();
    document.getElementById('event-edit-id').value = '';
    document.getElementById('event-form-title').textContent = 'Record an event';
    document.getElementById('event-submit').textContent = 'Save event';
    document.getElementById('event-cancel').hidden = true;
    document.getElementById('correction-reason-field').hidden = true;
    document.getElementById('correction_reason').required = false;
    document.getElementById('event_date').value = today();
    calvingSource.value = 'predicted';
    updateCalvingSourceState();
    updateDrugPreview();
  }

  function startEdit(id) {
    if (!['owner', 'vet'].includes(state.user?.role)) {
      showNotice('#event-result', 'Owner or vet access is required to correct an existing event.', 'info');
      return;
    }
    const row = state.events.find(event => event.id === id);
    if (!row) return;
    document.getElementById('event-edit-id').value = row.id;
    document.getElementById('cow_id').value = row.cow_id;
    document.getElementById('event_type').value = row.event_type;
    document.getElementById('event_date').value = row.event_date;
    document.getElementById('calving_date').value = row.calving_date || '';
    calvingSource.value = row.calving_date_source || 'predicted';
    document.getElementById('drug_id').value = row.drug_id || '';
    document.getElementById('diagnosis').value = row.diagnosis || '';
    document.getElementById('milkings_per_day').value = '';
    document.getElementById('notes').value = row.notes || '';
    updateDrugPreview();
    updateCalvingSourceState();
    document.getElementById('drug_rule_id').value = row.drug_rule_id || '';
    document.getElementById('event-form-title').textContent = `Correct event for cow ${row.tag_number}`;
    document.getElementById('event-submit').textContent = 'Save correction';
    document.getElementById('event-cancel').hidden = false;
    document.getElementById('correction-reason-field').hidden = false;
    document.getElementById('correction_reason').required = true;
    document.getElementById('correction_reason').value = '';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function showCorrectionHistory(id) {
    const panel = document.getElementById('correction-history');
    const rows = await requestJson(`/api/events/${id}/corrections`);
    panel.hidden = false;
    panel.innerHTML = rows.length ? `<strong>Correction history</strong><ul class="list" style="margin-top:10px">${rows.map(row => `<li><strong>${escapeHtml(row.corrected_by_name)}</strong> · ${escapeHtml(row.corrected_at)}<br>${escapeHtml(row.reason)}</li>`).join('')}</ul>` : '<strong>No corrections recorded for this event.</strong>';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function loadEvents() {
    state.events = await requestJson('/api/events');
    renderEvents();
  }

  async function loadInitialData() {
    try {
      const [cows, drugs, events, schedule, user] = await Promise.all([
        requestJson('/api/cows'), requestJson('/api/drugs'),
        requestJson('/api/events'), requestJson('/api/milking-schedule'),
        requestJson('/api/auth/me')
      ]);
      Object.assign(state, { cows, drugs, events, schedule, user });
      document.getElementById('event-identity').textContent = `${user.name} · ${humanize(user.role)} (recorded automatically)`;
      populateSelect(document.getElementById('cow_id'), cows.filter(cow => cow.status !== 'culled'), {
        placeholder: 'Select cow', label: cow => `Cow ${cow.tag_number} · ${humanize(cow.status)}`
      });
      populateSelect(drugSelect, drugs, {
        placeholder: 'No medicine', label: drug => `${drug.drug_name} · ${drug.withdrawal_summary}`
      });
      const queryCow = new URLSearchParams(window.location.search).get('cow');
      if (queryCow && cows.some(cow => String(cow.id) === queryCow)) {
        document.getElementById('cow_id').value = queryCow;
      }
      const editId = Number(new URLSearchParams(window.location.search).get('edit'));
      if (editId) startEdit(editId);
      renderEvents();
      updateDrugPreview();
    } catch (error) {
      document.getElementById('event-list').innerHTML = emptyState('Unable to load events', error.message);
      showNotice('#event-result', error.message, 'error');
    }
  }

  drugSelect.addEventListener('change', updateDrugPreview);
  document.getElementById('event_type').addEventListener('change', () => {
    updateCalvingSourceState();
    updateDrugPreview();
  });
  document.getElementById('event_date').addEventListener('change', updateScheduleHint);
  calvingInput.addEventListener('change', updateScheduleHint);
  document.getElementById('milkings_per_day').addEventListener('change', updateScheduleHint);
  regimenSelect.addEventListener('change', () => {
    document.getElementById('regimen-description').textContent =
      regimenSelect.selectedOptions[0]?.dataset.description || '';
  });
  document.getElementById('event-search').addEventListener('input', renderEvents);
  document.getElementById('event-filter').addEventListener('change', renderEvents);
  document.getElementById('event-cancel').addEventListener('click', resetForm);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const value = id => document.getElementById(id).value;
    const payload = {
      cow_id: Number(value('cow_id')),
      event_type: value('event_type'),
      event_date: value('event_date'),
      calving_date: value('calving_date') || null,
      calving_date_source: value('calving_date') ? value('calving_date_source') : null,
      drug_id: value('drug_id') ? Number(value('drug_id')) : null,
      drug_rule_id: value('drug_rule_id') ? Number(value('drug_rule_id')) : null,
      diagnosis: value('diagnosis') || null,
      milkings_per_day: value('milkings_per_day') ? Number(value('milkings_per_day')) : null,
      notes: value('notes').trim() || null
    };
    const editId = Number(value('event-edit-id'));
    if (editId) payload.correction_reason = value('correction_reason').trim();

    setBusy(submit, true, 'Saving event…');
    try {
      const saved = await requestJson(editId ? `/api/events/${editId}` : '/api/events', jsonOptions(editId ? 'PUT' : 'POST', payload));
      const reconciled = saved.reconciled_dry_off_events || [];
      const detail = reconciled.length
        ? `${saved.withdrawal_message} ${reconciled.length} dry-cow record(s) were recalculated from the actual calving date.`
        : saved.withdrawal_message;
      showNotice('#event-result', detail, saved.withdrawal_status === 'calculated' || saved.withdrawal_status === 'not_applicable' ? 'success' : 'warning');
      setBusy(submit, false);
      resetForm();
      await loadEvents();
    } catch (error) {
      showNotice('#event-result', error.message, 'error');
    } finally {
      if (submit.disabled) setBusy(submit, false);
    }
  });

  loadInitialData();
});
