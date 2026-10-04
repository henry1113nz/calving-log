document.addEventListener('DOMContentLoaded', async () => {
  const { badge, emptyState, escapeHtml, formatDate, humanize, requestJson, showNotice } = window.CalvingLog;
  let references = null;
  let user = null;
  function render() {
    const query = document.getElementById('medicine-search').value.trim().toLowerCase();
    const filter = document.getElementById('medicine-filter').value;
    const drugs = references.drugs.filter(drug => {
      const searchable = `${drug.drug_name} ${drug.active_ingredient || ''} ${drug.acvm_registration_no || ''}`.toLowerCase();
      return (!query || searchable.includes(query)) && (!filter || (filter === 'active' && drug.is_active) || (filter === 'inactive' && !drug.is_active) || (filter === 'dry' && drug.calculation_basis === 'calving_date') || (filter === 'lactating' && drug.calculation_basis === 'treatment_date'));
    });
    const target = document.getElementById('medicine-list');
    target.className = '';
    target.innerHTML = drugs.length ? `<div class="medicine-grid">${drugs.map(drug => `<article class="medicine-card${drug.is_active ? '' : ' inactive'}">
      <div class="medicine-head"><div><h3 class="medicine-name">${escapeHtml(drug.drug_name)}</h3><p class="list-detail">${escapeHtml(drug.active_ingredient || '')}</p></div>${badge(drug.is_active ? 'Verified active' : 'Inactive', drug.is_active ? 'success' : 'warning')}</div>
      <p class="list-detail"><strong>Milk withholding:</strong> ${escapeHtml(drug.withdrawal_summary || (drug.requires_regimen ? 'Select the matching label course' : `${drug.milk_withdrawal_value} ${drug.milk_withdrawal_unit}`))}</p>
      ${drug.minimum_dry_period_days ? `<p class="notice info">Early calving: full ${drug.minimum_dry_period_days} days from treatment, then ${drug.milk_withdrawal_value} milkings. Both conditions apply.</p>` : ''}
      <details class="medicine-label"><summary>Evidence &amp; label courses</summary>
      <dl class="medicine-meta"><dt>ACVM</dt><dd>${escapeHtml(drug.acvm_registration_no || 'Not recorded')}</dd><dt>Milk WHP</dt><dd>${drug.requires_regimen ? 'Use the matching course below' : `${drug.milk_withdrawal_value} ${escapeHtml(drug.milk_withdrawal_unit)}`}</dd><dt>Basis</dt><dd>${escapeHtml(humanize(drug.calculation_basis))}</dd><dt>Meat WHP</dt><dd>${drug.meat_withdrawal_days === null ? 'Not recorded' : `${drug.meat_withdrawal_days} days`}</dd><dt>Label</dt><dd>${escapeHtml(drug.label_revision || 'No current approved label')}</dd><dt>Checked</dt><dd>${drug.verified_on ? `${escapeHtml(formatDate(drug.verified_on))} · ${escapeHtml(drug.verified_by)}` : 'Not verified'}</dd></dl>
      ${(drug.rules || []).length ? `<div class="table-wrap"><table><thead><tr><th>Label course</th><th>OAD milkings</th><th>TAD milkings</th></tr></thead><tbody>${drug.rules.map(rule => `<tr><td>${escapeHtml(rule.rule_name)}<br><span class="hint">${escapeHtml(rule.description)}</span></td><td>${rule.milkings_once_daily ?? 'Not labelled'}</td><td>${rule.milkings_twice_daily ?? 'Not labelled'}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </details>
      <details class="medicine-label"><summary>Label wording and official source</summary><p>${escapeHtml(drug.label_wording || 'No verified wording stored.')}</p>${drug.source_reference?.startsWith('https://') ? `<a href="${escapeHtml(drug.source_reference)}" target="_blank" rel="noreferrer">Open approved label</a>` : ''}</details>
      <div class="form-actions">${['owner','vet'].includes(user.role) ? `<a class="btn secondary small" href="/medicine-editor.html?id=${drug.id}">Edit evidence and rules</a>` : ''}${drug.is_active ? `<a class="btn small" href="/events.html?drug=${drug.id}">Record treatment</a>` : ''}</div>
    </article>`).join('')}</div>` : emptyState('No matching medicines', 'Try a different name, ingredient or availability filter.');
  }
  try {
    [references, user] = await Promise.all([requestJson('/api/drugs/reference-status'), requestJson('/api/auth/me')]);
    document.getElementById('medicine-verified').textContent = `${references.verified_active_count}/${references.active_count}`;
    document.getElementById('medicine-unverified').textContent = references.unverified_active_count;
    document.getElementById('medicine-inactive').textContent = references.inactive_count;
    for (const id of ['manage-medicines','manage-medicines-inline']) document.getElementById(id).hidden = !['owner','vet'].includes(user.role);
    showNotice('#reference-summary', references.unverified_active_count ? 'Some active references are incomplete and require review.' : 'Active medicines have complete label evidence. Check the course, source and actual treatment before use.', references.unverified_active_count ? 'error' : 'info');
    document.getElementById('medicine-search').addEventListener('input', render);
    document.getElementById('medicine-filter').addEventListener('change', render);
    render();
    if (window.location.hash.startsWith('#schedule')) window.location.replace('/schedule.html');
  } catch(error) { document.getElementById('medicine-list').innerHTML = emptyState('Unable to load medicines', error.message); }
});
