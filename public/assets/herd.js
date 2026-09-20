document.addEventListener('DOMContentLoaded', () => {
  const {
    badge, emptyState, escapeHtml, formatDate, humanize, jsonOptions,
    requestJson, setBusy, showNotice
  } = window.CalvingLog;
  const state = { cows: [] };
  const form = document.getElementById('cow-form');

  function updateStats() {
    document.getElementById('herd-total').textContent = state.cows.length;
    for (const status of ['lactating', 'dry', 'culled']) {
      document.getElementById(`herd-${status}`).textContent =
        state.cows.filter(cow => cow.status === status).length;
    }
  }

  function statusBadge(status) {
    return badge(humanize(status), status === 'lactating' ? 'success' : status === 'dry' ? 'info' : '');
  }

  function filteredCows() {
    const search = document.getElementById('cow-search').value.trim().toLowerCase();
    const status = document.getElementById('cow-status-filter').value;
    return state.cows.filter(cow => {
      const haystack = `${cow.tag_number} ${cow.breed || ''}`.toLowerCase();
      return (!search || haystack.includes(search)) && (!status || cow.status === status);
    });
  }

  function renderCows() {
    updateStats();
    const target = document.getElementById('cow-list');
    target.className = '';
    const cows = filteredCows();
    if (!cows.length) {
      target.innerHTML = emptyState('No matching cows', 'Change the filters or add a new cow.');
      return;
    }
    target.innerHTML = `<div class="cow-grid">${cows.map(cow => `
      <article class="cow-card">
        <div class="cow-head"><div><p class="cow-tag">Cow ${escapeHtml(cow.tag_number)}</p><div class="list-meta"><span>${escapeHtml(cow.breed || 'Breed not recorded')}</span>${statusBadge(cow.status)}</div></div></div>
        <p class="list-detail">Lactation ${cow.lactation_number ?? '—'}${cow.birth_date ? ` · Born ${escapeHtml(formatDate(cow.birth_date, { short: true }))}` : ''}</p>
        <div class="form-actions">
          <a class="btn small" href="/events.html?cow=${cow.id}">Record event</a>
          <a class="btn secondary small" href="/dry-off.html?cow=${cow.id}">Dry-off</a>
          <button class="btn secondary small edit-cow" type="button" data-id="${cow.id}">Edit</button>
        </div>
      </article>`).join('')}</div>`;

    target.querySelectorAll('.edit-cow').forEach(button => {
      button.addEventListener('click', () => startEdit(Number(button.dataset.id)));
    });
  }

  function resetForm() {
    form.reset();
    document.getElementById('cow-edit-id').value = '';
    document.getElementById('cow-form-title').textContent = 'Add a cow';
    document.getElementById('cow-submit').textContent = 'Add cow';
    document.getElementById('cow-cancel').hidden = true;
  }

  function startEdit(id) {
    const cow = state.cows.find(item => item.id === id);
    if (!cow) return;
    document.getElementById('cow-edit-id').value = cow.id;
    document.getElementById('tag_number').value = cow.tag_number;
    document.getElementById('breed').value = cow.breed || '';
    document.getElementById('birth_date').value = cow.birth_date || '';
    document.getElementById('lactation_number').value = cow.lactation_number ?? '';
    document.getElementById('status').value = cow.status;
    document.getElementById('cow-form-title').textContent = `Edit cow ${cow.tag_number}`;
    document.getElementById('cow-submit').textContent = 'Save changes';
    document.getElementById('cow-cancel').hidden = false;
    document.getElementById('cow-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function loadCows() {
    try {
      state.cows = await requestJson('/api/cows');
      renderCows();
    } catch (error) {
      document.getElementById('cow-list').innerHTML = emptyState('Unable to load herd', error.message);
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const id = document.getElementById('cow-edit-id').value;
    const payload = {
      tag_number: document.getElementById('tag_number').value.trim(),
      breed: document.getElementById('breed').value.trim() || null,
      birth_date: document.getElementById('birth_date').value || null,
      lactation_number: document.getElementById('lactation_number').value === ''
        ? null
        : Number(document.getElementById('lactation_number').value),
      status: document.getElementById('status').value
    };
    const submit = document.getElementById('cow-submit');
    setBusy(submit, true, id ? 'Saving…' : 'Adding…');
    try {
      await requestJson(id ? `/api/cows/${id}` : '/api/cows', jsonOptions(id ? 'PUT' : 'POST', payload));
      showNotice('#cow-result', id ? 'Cow record updated.' : 'Cow added to the herd.', 'success');
      resetForm();
      await loadCows();
    } catch (error) {
      showNotice('#cow-result', error.message, 'error');
    } finally {
      setBusy(submit, false);
    }
  });

  document.getElementById('cow-cancel').addEventListener('click', resetForm);
  document.getElementById('cow-search').addEventListener('input', renderCows);
  document.getElementById('cow-status-filter').addEventListener('change', renderCows);
  loadCows();
});
