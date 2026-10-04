document.addEventListener('DOMContentLoaded', () => {
  const { escapeHtml, formatTimestamp, requestJson, jsonOptions, setBusy, showNotice } = window.CalvingLog;
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-question');
  const log = document.getElementById('chat-messages');
  const ai = document.getElementById('chat-use-ai');
  const share = document.getElementById('chat-share-data');
  const language = document.getElementById('chat-language');
  const send = document.getElementById('chat-submit');
  const clear = document.getElementById('chat-clear');
  const progress = document.getElementById('chat-progress');
  let conversationId = null;
  let busy = false;
  let messages = [];
  let available = false;
  const allowedSources = new Set(['/', '/assistant.html', '/herd.html', '/events.html', '/medicines.html', '/schedule.html', '/reviews.html', '/dry-off.html']);

  function render() {
    if (!messages.length) {
      log.innerHTML = '<div class="chat-welcome"><h3>Start a conversation</h3><p>Ask about the app or demo records. You can change AI and sharing options before sending.</p></div>';
      return;
    }
    log.innerHTML = messages.map(message => {
      const answer = message.answer;
      const sources = answer?.sources || [];
      const mode = !answer ? 'Message' : answer.mode === 'external' ? `${answer.provider} · AI response` : 'Local lookup · not an AI conversation';
      return `<article class="chat-message ${message.role === 'user' ? 'chat-user' : 'chat-assistant'}">
        <div class="chat-message-label">${message.role === 'user' ? 'You' : escapeHtml(mode)}</div>
        <div class="chat-message-body">${escapeHtml(message.text)}</div>
        ${answer ? `<p class="hint">${answer.data_shared ? 'Selected demo results shared with AI' : 'No database results sent to AI'} · No records changed</p>` : ''}
        ${answer?.notice ? `<div class="notice warning">${escapeHtml(answer.notice)}</div>` : ''}
        ${sources.length ? `<details class="chat-sources"><summary>Check sources (${sources.length})</summary>${sources.map(source => `<details><summary>${allowedSources.has(source.href) ? `<a href="${escapeHtml(source.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)}</a>` : escapeHtml(source.label)}${source.checked_at ? ` <span class="hint" title="${escapeHtml(source.checked_at)}">Checked ${escapeHtml(formatTimestamp(source.checked_at))}</span>` : ''}</summary><pre>${escapeHtml(JSON.stringify(source.facts || {}, null, 2))}</pre></details>`).join('')}</details>` : ''}
      </article>`;
    }).join('');
  }

  async function reset() {
    if (busy) return;
    busy = true;
    setBusy(clear, true, 'Clearing…');
    send.disabled = true; language.disabled = true; ai.disabled = true; share.disabled = true;
    try {
      if (conversationId) await requestJson('/api/assistant/chat/clear', jsonOptions('POST', { conversation_id: conversationId }));
      conversationId = null; messages = []; render();
      showNotice('#chat-notice', 'New conversation. No farm records were changed.', 'info');
    } catch (error) {
      showNotice('#chat-notice', error.message, 'warning');
    } finally {
      busy = false; setBusy(clear, false); send.disabled = false; language.disabled = false;
      ai.disabled = !available; updateConsent();
    }
  }

  function updateConsent() {
    share.disabled = !ai.checked || ai.disabled || busy;
    if (!ai.checked) share.checked = false;
  }

  async function ask() {
    const question = input.value.trim();
    if (!question || busy) return;
    busy = true;
    messages.push({ role: 'user', text: question }); render();
    setBusy(send, true, 'Thinking…');
    clear.disabled = true; ai.disabled = true; share.disabled = true; language.disabled = true;
    progress.textContent = 'Reading context and checking records…';
    showNotice('#chat-notice', '');
    const usedAI = ai.checked;
    try {
      const answer = await requestJson('/api/assistant/chat', jsonOptions('POST', {
        question, language: language.value || 'en', use_ai: usedAI,
        share_data: usedAI && share.checked, conversation_id: conversationId
      }));
      conversationId = answer.conversation_id || null;
      messages.push({ role: 'assistant', text: answer.reply, answer });
      if (input.value.trim() === question) input.value = '';
      render();
    } catch (error) {
      messages.push({ role: 'assistant', text: `${error.message}\nNo records were changed.` }); render();
      showNotice('#chat-notice', error.message, 'error');
    } finally {
      busy = false; setBusy(send, false); clear.disabled = false;
      ai.disabled = !available; language.disabled = false; updateConsent(); progress.textContent = ''; input.focus();
    }
  }

  form.addEventListener('submit', event => { event.preventDefault(); return ask(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault(); form.requestSubmit();
    }
  });
  clear.addEventListener('click', reset);
  ai.addEventListener('change', async () => { updateConsent(); await reset(); });
  share.addEventListener('change', reset);
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-chat-example]');
    if (button) { input.value = button.dataset.chatExample; input.focus(); }
  });
  requestJson('/api/assistant/status').then(status => {
    available = Boolean(status.external_ai_available);
    // Defaults do not send anything: only submitting the message contacts the provider.
    if (!busy) { ai.checked = available; share.checked = available; }
    ai.disabled = !available || busy; updateConsent();
    document.getElementById('assistant-settings-link').hidden = !status.can_test_connection;
    document.getElementById('chat-ai-label').textContent = available
      ? `Use ${status.provider} AI`
      : 'AI unavailable · local lookups still work';
    document.getElementById('assistant-status').textContent = available
      ? `${status.provider} configured · ${status.connection_test?.state === 'connected' ? 'Last connection test passed' : 'Connection not tested'}. Each reply shows its actual mode.`
      : `Local lookup mode. ${status.configuration_message}`;
  }).catch(error => { document.getElementById('assistant-status').textContent = error.message; });
});
