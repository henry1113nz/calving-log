document.addEventListener('DOMContentLoaded', async () => {
  const { badge, emptyState, escapeHtml, formatDate, humanize, jsonOptions, requestJson, showNotice } = window.CalvingLog;
  const id = new URLSearchParams(window.location.search).get('id');
  try {
    const [cows, events, scc, user] = await Promise.all([requestJson('/api/cows'),requestJson('/api/events'),requestJson('/api/scc'),requestJson('/api/auth/me')]);
    const cow = cows.find(item => String(item.id) === id);
    if (!cow) throw new Error('Cow not found. Select a cow from the Herd page.');
    document.getElementById('cow-title').textContent = `Cow ${cow.tag_number}`;
    document.getElementById('cow-summary').textContent = `${cow.breed || 'Breed not recorded'} · ${humanize(cow.status)} · Lactation ${cow.lactation_number ?? 'not recorded'}`;
    const hold = await requestJson('/api/assistant/query', jsonOptions('POST',{question:`Why is cow ${cow.tag_number} on hold?`}));
    document.getElementById('cow-hold').innerHTML = `<p class="notice ${hold.requires_attention ? 'warning' : 'info'}">${escapeHtml(hold.message)}</p>`;
    const actions = document.getElementById('cow-actions');
    actions.innerHTML = cow.status === 'culled'
      ? '<p>This cow is retained for history. An Owner or Vet can restore her status from Herd.</p><a class="btn secondary" href="/herd.html">Open Herd</a>'
      : `<a class="btn" href="/events.html?cow=${cow.id}">Record event</a><a class="btn secondary" href="/dry-off.html?cow=${cow.id}">Dry-off review</a>${['owner','vet'].includes(user.role) ? '<button class="btn secondary" type="button" id="cull-cow">Mark culled / archive</button>' : ''}`;
    document.getElementById('cull-cow')?.addEventListener('click', async () => {
      if (!window.confirm('Mark this cow culled? Her events and label evidence remain available. You can restore her status from Herd.')) return;
      try { await requestJson(`/api/cows/${cow.id}`,jsonOptions('PUT',{status:'culled'})); window.location.reload(); }
      catch(error) { showNotice('#cow-notice',error.message,'error'); }
    });
    const history = events.filter(item => String(item.cow_id) === id);
    const target = document.getElementById('cow-history');
    target.className = '';
    target.innerHTML = history.length ? `<ul class="list">${history.map(item => {
      const predicted = item.calving_date_source === 'predicted';
      const variant = predicted ? 'warning' : (['calculated','not_applicable'].includes(item.withdrawal_status) ? 'info' : 'danger');
      const auditHref = `/events.html?history=${item.id}${['owner','vet'].includes(user.role) ? `&edit=${item.id}` : ''}`;
      return `<li>
        <h3>${escapeHtml(formatDate(item.event_date,{short:true}))} · ${escapeHtml(humanize(item.event_type))}</h3>
        <p>${escapeHtml(item.drug_name || 'No medicine')}${item.drug_rule_name ? ` · ${escapeHtml(item.drug_rule_name)}` : ''}</p>
        ${badge(predicted ? 'Actual calving needed' : humanize(item.withdrawal_status),variant)}
        <p>${item.withdrawal_end_date ? `${predicted ? 'Planning estimate only' : 'Hold through'} ${escapeHtml(formatDate(item.withdrawal_end_date))}` : 'No medicine clear date recorded'}</p>
        <p class="list-detail">${escapeHtml(item.created_by_name || '')} · ${escapeHtml(item.notes || '')}</p>
        <details><summary>Stored evidence and correction history</summary>
          <p>${escapeHtml(item.reference_label_revision || 'No label revision applicable')} · Reference ${escapeHtml(item.drug_reference_revision_id ?? 'not applicable')}</p>
          <p>${escapeHtml(item.milkings_per_day_applied ?? 'Not recorded')} milkings/day</p>
          <a href="${auditHref}">Open event and audit history</a>
        </details>
      </li>`;
    }).join('')}</ul>` : emptyState('No events recorded', 'This means no records, not automatic milk release.');
    const evidence = scc.filter(item => String(item.cow_id) === id);
    document.getElementById('cow-scc').innerHTML = evidence.length ? `<ul class="list">${evidence.map(item => `<li>${escapeHtml(formatDate(item.test_date))} · SCC ${escapeHtml(item.scc_value)}</li>`).join('')}</ul>` : emptyState('No SCC evidence recorded', 'Add evidence on the Dry-off page.');
  } catch(error) { showNotice('#cow-notice',error.message,'error'); document.getElementById('cow-history').textContent = error.message; }
});
