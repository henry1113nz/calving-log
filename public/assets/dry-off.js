document.addEventListener('DOMContentLoaded', () => {
  const {
    badge, currentSeason, emptyState, escapeHtml, formatDate, humanize,
    jsonOptions, populateSelect, requestJson, setBusy, showNotice, today
  } = window.CalvingLog;
  const state = { cows: [], scc: [], decisions: [], advice: null, user: null };
  const cowSelect = document.getElementById('review_cow');
  document.getElementById('review_season').value = currentSeason();
  document.getElementById('scc_test_date').value = today();

  function selectedCowId() {
    return Number(cowSelect.value) || null;
  }

  function selectedCowScc() {
    return state.scc.filter(record => record.cow_id === selectedCowId());
  }

  function renderRecommendation() {
    const target = document.getElementById('recommendation');
    target.className = '';
    const advice = state.advice;
    if (!selectedCowId()) {
      target.innerHTML = emptyState('Select a cow', 'The advisor needs an individual cow record.');
      return;
    }
    if (!advice) {
      target.innerHTML = emptyState('Recommendation unavailable');
      return;
    }
    if (!advice.sufficient_evidence) {
      target.innerHTML = `<div class="recommendation empty">${badge('Insufficient evidence', 'warning')}<h3>No recommendation</h3><p>${escapeHtml(advice.evidence?.note || 'Record SCC or clinical mastitis evidence first.')}</p></div>`;
      return;
    }

    const antibiotic = advice.recommendation === 'antibiotic_dct';
    const title = antibiotic ? 'Antibiotic dry cow therapy' : 'Teat seal only';
    const criteria = advice.criteria_met || [];
    target.innerHTML = `
      <div class="recommendation${antibiotic ? ' warning' : ''}">
        ${badge('Decision support', antibiotic ? 'warning' : 'success')}
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(advice.evidence?.note || '')}</p>
        <div class="list-meta" style="margin-top:12px">
          <span>Threshold ${Number(advice.evidence?.threshold_applied || 0).toLocaleString('en-NZ')}</span>
          <span>Highest SCC ${advice.evidence?.highest_scc == null ? '—' : Number(advice.evidence.highest_scc.scc_value).toLocaleString('en-NZ')}</span>
          <span>${advice.evidence?.mastitis_event_count || 0} mastitis event(s)</span>
        </div>
        ${criteria.length ? `<ul class="warning-list">${criteria.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
      </div>`;

    document.getElementById('decision').value = advice.recommendation;
    if (!document.getElementById('justification').value) {
      document.getElementById('justification').value = advice.evidence?.note || '';
    }
  }

  function renderScc() {
    const rows = selectedCowScc();
    const target = document.getElementById('scc-history');
    target.className = '';
    if (!rows.length) {
      target.innerHTML = emptyState('No SCC records for this cow', 'Add individual evidence before relying on a teat-seal-only recommendation.');
    } else {
      target.innerHTML = `<ul class="list">${rows.map(record => `
        <li class="list-row"><div class="list-main"><p class="list-title">${Number(record.scc_value).toLocaleString('en-NZ')} cells/mL</p><div class="list-meta"><span>${escapeHtml(formatDate(record.test_date, { short: true }))}</span>${badge(humanize(record.source), 'info')}</div></div></li>`).join('')}</ul>`;
    }

    populateSelect(document.getElementById('supporting_scc_id'), rows, {
      placeholder: 'No supporting SCC selected',
      label: record => `${formatDate(record.test_date, { short: true })} · ${Number(record.scc_value).toLocaleString('en-NZ')}`
    });
  }

  function renderDecisions() {
    const target = document.getElementById('decision-history');
    target.className = '';
    if (!state.decisions.length) {
      target.innerHTML = emptyState('No dry-off decisions recorded');
      return;
    }
    target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Cow / season</th><th>Decision</th><th>Evidence</th><th>Decided by</th></tr></thead><tbody>${state.decisions.map(decision => `
      <tr><td><strong>Cow ${escapeHtml(decision.tag_number)}</strong><br><span class="list-detail">${escapeHtml(decision.season)}</span></td><td>${badge(humanize(decision.decision), decision.decision === 'antibiotic_dct' ? 'warning' : 'success')}<br><span class="list-detail">${escapeHtml(decision.justification || 'No justification recorded')}</span></td><td>${decision.supporting_scc_value == null ? 'No SCC linked' : `${Number(decision.supporting_scc_value).toLocaleString('en-NZ')} · ${escapeHtml(formatDate(decision.supporting_scc_date, { short: true }))}`}</td><td>${escapeHtml(decision.decided_by_name || 'Not recorded')}</td></tr>`).join('')}</tbody></table></div>`;
  }

  async function loadAdvice() {
    const cowId = selectedCowId();
    if (!cowId) {
      state.advice = null;
      renderRecommendation();
      renderScc();
      return;
    }
    const season = document.getElementById('review_season').value.trim();
    try {
      state.advice = await requestJson(`/api/cows/${cowId}/dry-off-recommendation?season=${encodeURIComponent(season)}`);
      renderRecommendation();
      renderScc();
    } catch (error) {
      document.getElementById('recommendation').innerHTML = emptyState('Unable to calculate recommendation', error.message);
    }
  }

  async function loadHistories() {
    const [scc, decisions] = await Promise.all([requestJson('/api/scc'), requestJson('/api/decisions')]);
    state.scc = scc;
    state.decisions = decisions;
    renderScc();
    renderDecisions();
  }

  async function loadInitialData() {
    try {
      const [cows, scc, decisions, user] = await Promise.all([
        requestJson('/api/cows'), requestJson('/api/scc'),
        requestJson('/api/decisions'), requestJson('/api/auth/me')
      ]);
      Object.assign(state, { cows, scc, decisions, user });
      populateSelect(cowSelect, cows.filter(cow => cow.status !== 'culled'), {
        placeholder: 'Select cow', label: cow => `Cow ${cow.tag_number} · lactation ${cow.lactation_number ?? '—'}`
      });
      document.getElementById('decision-identity').textContent = `${user.name} · ${humanize(user.role)} (recorded automatically)`;
      const canDecide = ['owner', 'vet'].includes(user.role);
      document.querySelectorAll('#decision-form select, #decision-form textarea, #decision-form button')
        .forEach(control => { control.disabled = !canDecide; });
      if (!canDecide) {
        showNotice('#decision-result', 'Owner or vet access is required to record the final dry-off decision.', 'info');
      }
      const queryCow = new URLSearchParams(window.location.search).get('cow');
      if (queryCow && cows.some(cow => String(cow.id) === queryCow)) cowSelect.value = queryCow;
      renderScc();
      renderDecisions();
      await loadAdvice();
    } catch (error) {
      document.getElementById('recommendation').innerHTML = emptyState('Unable to load dry-off workspace', error.message);
    }
  }

  cowSelect.addEventListener('change', loadAdvice);
  document.getElementById('review_season').addEventListener('change', loadAdvice);
  document.getElementById('refresh-advice').addEventListener('click', loadAdvice);

  document.getElementById('scc-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (!selectedCowId()) {
      showNotice('#scc-result', 'Select a cow before recording an SCC result.', 'error');
      return;
    }
    const payload = {
      cow_id: selectedCowId(),
      test_date: document.getElementById('scc_test_date').value,
      scc_value: Number(document.getElementById('scc_value').value),
      source: document.getElementById('scc_source').value
    };
    setBusy(submit, true, 'Saving…');
    try {
      await requestJson('/api/scc', jsonOptions('POST', payload));
      showNotice('#scc-result', 'SCC result recorded and available to the advisor.', 'success');
      document.getElementById('scc_value').value = '';
      await loadHistories();
      await loadAdvice();
    } catch (error) {
      showNotice('#scc-result', error.message, 'error');
    } finally {
      setBusy(submit, false);
    }
  });

  document.getElementById('decision-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (!selectedCowId()) {
      showNotice('#decision-result', 'Select a cow before recording a decision.', 'error');
      return;
    }
    const payload = {
      cow_id: selectedCowId(),
      season: document.getElementById('review_season').value.trim(),
      decision: document.getElementById('decision').value,
      justification: document.getElementById('justification').value.trim() || null,
      supporting_scc_id: document.getElementById('supporting_scc_id').value
        ? Number(document.getElementById('supporting_scc_id').value)
        : null
    };
    setBusy(submit, true, 'Recording…');
    try {
      await requestJson('/api/decisions', jsonOptions('POST', payload));
      showNotice('#decision-result', 'Dry-off decision recorded with its evidence.', 'success');
      await loadHistories();
    } catch (error) {
      showNotice('#decision-result', error.message, 'error');
    } finally {
      setBusy(submit, false);
    }
  });

  loadInitialData();
});
