document.addEventListener('DOMContentLoaded', () => {
  const {
    badge, emptyState, escapeHtml, formatDate, humanize, jsonOptions,
    requestJson, setBusy, showNotice
  } = window.CalvingLog;

  const form = document.getElementById('assistant-form');
  const questionField = document.getElementById('assistant-question');
  const result = document.getElementById('assistant-result');
  let pendingDraft = null;

  function modeBadge(payload) {
    return badge('Local constrained intent', 'info');
  }

  function warningList(warnings) {
    return (warnings || []).length
      ? `<ul class="warning-list">${warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '';
  }

  function questionList(questions) {
    return (questions || []).length
      ? `<ul class="warning-list">${questions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '';
  }

  function renderVatAnswer(payload) {
    const rows = payload.rows || [];
    result.innerHTML = `
      <div class="notice info"><strong>${escapeHtml(payload.message)}</strong><br>
        ${modeBadge(payload)} ${badge('Database result', 'success')}
      </div>
      ${rows.length ? `<ul class="list" style="margin-top:14px">${rows.map(row => {
        const unresolved = row.requires_attention || !row.withdrawal_end_date;
        return `<li class="list-row hold-row${unresolved ? ' urgent' : ''}">
          <div class="list-main">
            <p class="list-title">Cow ${escapeHtml(row.tag_number)} · ${escapeHtml(row.drug_name || humanize(row.event_type))}</p>
            <p class="list-detail">${unresolved
              ? 'No authoritative eligible date. Human review is required.'
              : `Hold through ${escapeHtml(formatDate(row.withdrawal_end_date, { short: true }))}; earliest eligible ${escapeHtml(formatDate(row.eligible_from_date, { short: true }))} if no other hold applies.`}</p>
            ${warningList(row.warnings)}
          </div>
          ${unresolved ? badge('Hold', 'danger') : badge(row.is_estimate ? 'Predicted' : 'Calculated', row.is_estimate ? 'warning' : 'success')}
        </li>`;
      }).join('')}</ul>` : emptyState('No medicine holds are listed today', 'Other animal-health and farm holds must still be checked.')}`;
  }

  // 解释一条记录时把证据一起摆出来:哪条标签规则、哪个版本、当时每天挤几次奶。
  // 只给一句"到某日解除",人就没有办法判断这个日期还成不成立。
  function evidenceLine(event) {
    const parts = [];
    if (event.drug_rule_name) parts.push(`Rule: ${event.drug_rule_name}`);
    if (event.acvm_registration_no) {
      parts.push(`ACVM ${event.acvm_registration_no}${event.label_revision ? ` · label ${event.label_revision}` : ''}`);
    }
    if (event.withdrawal_days_applied !== null && event.withdrawal_days_applied !== undefined) {
      parts.push(`${event.withdrawal_days_applied} day${event.withdrawal_days_applied === 1 ? '' : 's'} applied`);
    }
    if (event.milkings_per_day_applied) parts.push(`${event.milkings_per_day_applied}× daily milking`);
    if (event.calving_date) {
      parts.push(`Calving ${formatDate(event.calving_date, { short: true })} (${humanize(event.calving_date_source)})`);
    }
    return parts.length
      ? `<p class="list-detail">${escapeHtml(parts.join(' · '))}</p>`
      : '';
  }

  function renderCowStatus(payload) {
    if (!payload.resolved) {
      result.innerHTML = `<div class="notice warning"><strong>${escapeHtml(payload.message)}</strong></div>`;
      return;
    }

    const events = payload.events || [];
    const variant = payload.requires_attention ? 'warning' : (payload.on_hold_today ? 'info' : 'success');
    result.innerHTML = `
      <div class="notice ${variant}"><strong>${escapeHtml(payload.message)}</strong><br>
        ${modeBadge(payload)} ${badge('Stored event snapshot', 'success')}
        ${payload.requires_attention ? badge('Needs a person', 'danger') : ''}
      </div>
      ${events.length ? `<ul class="list" style="margin-top:14px">${events.map(event => {
        const status = event.requires_attention
          ? badge('Attention', 'danger')
          : (event.on_hold_today
            ? badge(event.is_estimate ? 'Predicted' : 'On hold', event.is_estimate ? 'warning' : 'info')
            : badge('No current hold', 'success'));
        return `<li class="list-row${event.requires_attention ? ' hold-row urgent' : ''}">
          <div class="list-main">
            <p class="list-title">${escapeHtml(formatDate(event.event_date, { short: true }))} · ${escapeHtml(humanize(event.event_type))}${event.drug_name ? ` · ${escapeHtml(event.drug_name)}` : ''}</p>
            <p class="list-detail">${event.withdrawal_end_date
              ? `Hold through ${escapeHtml(formatDate(event.withdrawal_end_date, { short: true }))}; earliest eligible ${escapeHtml(formatDate(event.eligible_from_date, { short: true }))}${event.days_remaining !== null && event.days_remaining !== undefined ? ` · ${escapeHtml(event.days_remaining)} day${event.days_remaining === 1 ? '' : 's'} left` : ''}.`
              : escapeHtml(`No clear date is stored (${humanize(event.withdrawal_status)}).`)}</p>
            ${evidenceLine(event)}
            ${warningList(event.warnings)}
          </div>
          ${status}
        </li>`;
      }).join('')}</ul>` : emptyState('No events are recorded for this cow', 'Nothing here means no record, not a cleared cow.')}`;
  }

  function renderDraft(payload) {
    pendingDraft = payload.can_confirm ? payload.confirm_with : null;
    const summary = payload.cow
      ? `Cow ${payload.cow.tag_number}${payload.event_date ? ` · ${formatDate(payload.event_date, { short: true })}` : ''}${payload.event_type ? ` · ${humanize(payload.event_type)}` : ''}`
      : '';

    if (!payload.resolved) {
      result.innerHTML = `
        <div class="notice warning"><strong>${escapeHtml(payload.message)}</strong><br>
          ${modeBadge(payload)} ${badge('Nothing saved', 'success')}
        </div>
        ${questionList(payload.questions)}`;
      return;
    }

    if (!payload.can_confirm) {
      result.innerHTML = `
        <div class="notice warning"><strong>${escapeHtml(payload.message)}</strong><br>
          ${modeBadge(payload)} ${badge('Nothing saved', 'success')}
        </div>
        ${summary ? `<p class="list-detail" style="margin-top:12px">${escapeHtml(summary)}</p>` : ''}
        ${payload.next_step ? `<p style="margin-top:12px"><a class="btn" href="${escapeHtml(payload.next_step.href)}">${escapeHtml(payload.next_step.label)}</a></p>` : ''}`;
      return;
    }

    result.innerHTML = `
      <div class="notice info"><strong>${escapeHtml(payload.message)}</strong><br>
        ${modeBadge(payload)} ${badge('Draft only — nothing saved', 'warning')}
      </div>
      <ul class="list" style="margin-top:14px">
        <li class="list-row">
          <div class="list-main">
            <p class="list-title">${escapeHtml(summary)}</p>
            <p class="list-detail">Check the cow and the date before confirming. Saving uses the normal treatment route, so the same validation, role checks and audit trail apply.</p>
          </div>
          ${badge('Awaiting confirmation', 'warning')}
        </li>
      </ul>
      <div class="form-actions"><button class="btn" id="draft-confirm" type="button">Confirm and save</button></div>`;
  }

  function renderSaved(payload, saved) {
    const reconciled = saved.reconciled_dry_off_events || [];
    result.innerHTML = `
      <div class="notice success"><strong>Saved. Cow ${escapeHtml(payload.cow.tag_number)} recorded as ${escapeHtml(humanize(saved.event_type))} on ${escapeHtml(formatDate(saved.event_date, { short: true }))}.</strong><br>
        ${badge('Written by you, not by the assistant', 'success')}
      </div>
      <p class="list-detail" style="margin-top:12px">${reconciled.length
        ? escapeHtml(`${reconciled.length} dry-cow record(s) that rested on an expected calving date were recalculated from the actual date.`)
        : 'No dry-cow record was waiting on this calving date.'}</p>
      <div class="form-actions">
        <button class="text-button" type="button" data-example="Why is cow ${escapeHtml(payload.cow.tag_number)} on hold?" data-run="1">Explain cow ${escapeHtml(payload.cow.tag_number)} now</button>
      </div>`;
  }

  function renderAnswer(payload) {
    result.className = '';
    pendingDraft = null;

    if (!payload.supported) {
      result.innerHTML = emptyState('Question not supported yet', payload.message);
      return;
    }
    if (payload.intent === 'cow_status') return renderCowStatus(payload);
    if (payload.intent === 'draft_event') return renderDraft(payload);
    return renderVatAnswer(payload);
  }

  async function ask(question) {
    const button = document.getElementById('assistant-submit');
    setBusy(button, true, 'Checking…');
    showNotice('#assistant-notice', '');
    try {
      const payload = await requestJson('/api/assistant/query', jsonOptions('POST', { question }));
      renderAnswer(payload);
      if (payload.notice) showNotice('#assistant-notice', payload.notice, 'info');

      const confirmButton = document.getElementById('draft-confirm');
      confirmButton?.addEventListener('click', async () => {
        if (!pendingDraft) return;
        setBusy(confirmButton, true, 'Saving…');
        try {
          const saved = await requestJson(pendingDraft.url, jsonOptions(pendingDraft.method, pendingDraft.body));
          pendingDraft = null;
          renderSaved(payload, saved);
        } catch (error) {
          showNotice('#assistant-notice', error.message, 'error');
          setBusy(confirmButton, false);
        }
      });
    } catch (error) {
      showNotice('#assistant-notice', error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-example]');
    if (!trigger) return;
    questionField.value = trigger.dataset.example;
    questionField.focus();
    if (trigger.dataset.run) ask(questionField.value);
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    ask(questionField.value.trim());
  });
});
