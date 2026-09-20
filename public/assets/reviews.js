document.addEventListener('DOMContentLoaded', async () => {
  const { badge, emptyState, escapeHtml, formatDate, humanize, requestJson } = window.CalvingLog;

  function openMarkup(rows, canCorrect) {
    if (!rows.length) return emptyState('No open reviews', 'Every current medicine event has an authoritative result.');
    return `<ul class="list">${rows.map(row => `
      <li class="list-row hold-row urgent">
        <div class="list-main"><p class="list-title">Cow ${escapeHtml(row.tag_number)} · ${escapeHtml(row.drug_name || 'Medicine event')}</p>
          <div class="list-meta">${badge(humanize(row.withdrawal_status), 'danger')}<span>Event ${escapeHtml(formatDate(row.event_date, { short: true }))}</span></div>
          <p class="list-detail">${escapeHtml(row.reason)}</p>
        </div>
        <div class="list-actions"><a class="btn small" href="${canCorrect ? `/events.html?edit=${row.health_event_id}` : '/events.html'}">${canCorrect ? 'Correct event' : 'View events'}</a></div>
      </li>`).join('')}</ul>`;
  }

  function resolvedMarkup(rows) {
    if (!rows.length) return emptyState('No resolved reviews yet', 'Closed reviews will remain here for audit.');
    return `<div class="table-wrap"><table><thead><tr><th>Cow / event</th><th>Reason</th><th>Resolution</th><th>Resolved by</th></tr></thead><tbody>${rows.map(row => `
      <tr><td><strong>Cow ${escapeHtml(row.tag_number)}</strong><br><span class="list-detail">${escapeHtml(formatDate(row.event_date, { short: true }))} · ${escapeHtml(row.drug_name || '')}</span></td>
      <td>${escapeHtml(row.reason)}</td><td>${escapeHtml(row.resolution || '')}</td><td>${escapeHtml(row.resolved_by_name || 'Not recorded')}<br><span class="list-detail">${escapeHtml(row.resolved_at || '')}</span></td></tr>`).join('')}</tbody></table></div>`;
  }

  try {
    const [rows, user] = await Promise.all([
      requestJson('/api/reviews?status=all'), requestJson('/api/auth/me')
    ]);
    const canCorrect = ['owner', 'vet'].includes(user.role);
    const open = rows.filter(row => row.status === 'open');
    const resolved = rows.filter(row => row.status === 'resolved');
    document.getElementById('review-open-count').textContent = open.length;
    document.getElementById('review-calving-count').textContent = open.filter(row => row.withdrawal_status === 'awaiting_calving_date').length;
    document.getElementById('review-vet-count').textContent = open.filter(row => row.withdrawal_status !== 'awaiting_calving_date').length;
    document.getElementById('review-resolved-count').textContent = resolved.length;
    document.getElementById('open-reviews').className = '';
    document.getElementById('resolved-reviews').className = '';
    document.getElementById('open-reviews').innerHTML = openMarkup(open, canCorrect);
    document.getElementById('resolved-reviews').innerHTML = resolvedMarkup(resolved);
  } catch (error) {
    document.getElementById('open-reviews').innerHTML = emptyState('Unable to load reviews', error.message);
    document.getElementById('resolved-reviews').innerHTML = '';
  }
});
