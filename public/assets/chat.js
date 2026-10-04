document.addEventListener('DOMContentLoaded', () => {
  const { escapeHtml, requestJson, jsonOptions, setBusy, showNotice } = window.CalvingLog;
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
      log.innerHTML = '<div class="chat-welcome"><h3>Start a conversation / 开始对话</h3><p>Ask about your project or demo records. Enable AI for natural replies; share demo-data results only when you agree.</p></div>';
      return;
    }
    log.innerHTML = messages.map(message => {
      const answer = message.answer;
      const sources = answer?.sources || [];
      const mode = !answer ? 'Message / 提示' : answer.mode === 'external' ? `${answer.provider} · AI response` : 'Local lookup · 本地查询（不是 AI 对话）';
      return `<article class="chat-message ${message.role === 'user' ? 'chat-user' : 'chat-assistant'}">
        <div class="chat-message-label">${message.role === 'user' ? 'You / 你' : escapeHtml(mode)}</div>
        <div class="chat-message-body">${escapeHtml(message.text)}</div>
        ${answer ? `<p class="hint">${answer.data_shared ? 'Selected demo data was shared with AI / 本次分享了选定演示数据' : 'No database results sent to AI / 未向 AI 发送数据库结果'} · No records changed / 未修改记录</p>` : ''}
        ${answer?.notice ? `<div class="notice warning">${escapeHtml(answer.notice)}</div>` : ''}
        ${sources.length ? `<div class="chat-sources"><strong>Server sources / 服务器数据来源</strong>${sources.map(source => `<details><summary>${allowedSources.has(source.href) ? `<a href="${escapeHtml(source.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)}</a>` : escapeHtml(source.label)} <span class="hint">${escapeHtml(source.checked_at || '')}</span></summary><pre>${escapeHtml(JSON.stringify(source.facts || {}, null, 2))}</pre></details>`).join('')}</div>` : ''}
      </article>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  async function reset() {
    if (busy) return;
    if (conversationId) {
      try { await requestJson('/api/assistant/chat/clear', jsonOptions('POST', { conversation_id: conversationId })); }
      catch (error) { showNotice('#chat-notice', error.message, 'warning'); return; }
    }
    conversationId = null; messages = []; render();
    showNotice('#chat-notice', 'New conversation. No farm records were changed. / 已开启新对话，未修改农场记录。', 'info');
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
    setBusy(send, true, 'Thinking / 正在回复…');
    clear.disabled = true; ai.disabled = true; share.disabled = true;
    progress.textContent = 'Reading context and checking records… / 正在读取上下文与查询记录…';
    showNotice('#chat-notice', '');
    const usedAI = ai.checked;
    try {
      const answer = await requestJson('/api/assistant/chat', jsonOptions('POST', {
        question, language: language.value || 'auto', use_ai: usedAI,
        share_data: usedAI && share.checked, conversation_id: conversationId
      }));
      conversationId = answer.conversation_id || null;
      messages.push({ role: 'assistant', text: answer.reply, answer });
      if (input.value.trim() === question) input.value = '';
      render();
    } catch (error) {
      messages.push({ role: 'assistant', text: `${error.message}\nNothing was changed. / 没有修改任何记录。` }); render();
      showNotice('#chat-notice', error.message, 'error');
    } finally {
      busy = false; setBusy(send, false); clear.disabled = false;
      ai.disabled = !available; updateConsent(); progress.textContent = ''; input.focus();
    }
  }

  form.addEventListener('submit', event => { event.preventDefault(); return ask(); });
  clear.addEventListener('click', reset);
  ai.addEventListener('change', async () => { updateConsent(); await reset(); });
  share.addEventListener('change', reset);
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-chat-example]');
    if (button) { input.value = button.dataset.chatExample; input.focus(); }
  });
  requestJson('/api/assistant/status').then(status => {
    available = Boolean(status.external_ai_available); ai.disabled = !available || busy; updateConsent();
    document.getElementById('assistant-settings-link').hidden = !status.can_test_connection;
    document.getElementById('chat-ai-label').textContent = available
      ? `Use ${status.provider} for conversation (messages + recent chat are sent). 使用外部 AI，可能产生少量费用。`
      : 'External AI unavailable. Simple local lookups still work. / 外部 AI 未配置，可使用简单本地查询。';
    document.getElementById('assistant-status').textContent = available
      ? `${status.provider} is configured. ${status.connection_test?.state === 'connected' ? 'The last basic connection test passed.' : 'A successful connection has not been assumed.'} Each reply shows its actual mode.`
      : `Local lookup mode. ${status.configuration_message}`;
  }).catch(error => { document.getElementById('assistant-status').textContent = error.message; });
});
