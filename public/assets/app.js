(() => {
  const pages = [
    { id: 'dashboard', href: '/', label: 'Dashboard', icon: '◫' },
    { id: 'events', href: '/events.html', label: 'Treatments', icon: '✚' },
    { id: 'reviews', href: '/reviews.html', label: 'Reviews', icon: '!' },
    { id: 'herd', href: '/herd.html', label: 'Herd', icon: '♧' },
    { id: 'dry-off', href: '/dry-off.html', label: 'Dry-off', icon: '◎' },
    { id: 'medicines', href: '/medicines.html', label: 'Medicines', icon: '◇' },
    { id: 'assistant', href: '/assistant.html', label: 'Ask', icon: '?' },
    { id: 'feedback', href: '/feedback.html', label: 'Feedback', icon: '✎' },
    { id: 'account', href: '/account.html', label: 'Account', icon: '○' }
  ];
  let currentUser = null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function humanize(value) {
    if (value === undefined || value === null || value === '') return 'Not recorded';
    return String(value).replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function formatDate(value, options = {}) {
    if (!value) return 'Not recorded';
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return value;
    return new Intl.DateTimeFormat('en-NZ', {
      day: 'numeric',
      month: options.short ? 'short' : 'long',
      year: options.noYear ? undefined : 'numeric',
      timeZone: 'UTC'
    }).format(parsed);
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function currentSeason(date = new Date()) {
    const year = date.getUTCFullYear();
    const startYear = date.getUTCMonth() >= 5 ? year : year - 1;
    return `${startYear}-${String(startYear + 1).slice(-2)}`;
  }

  function badge(text, variant = '') {
    return `<span class="badge${variant ? ` ${variant}` : ''}">${escapeHtml(text)}</span>`;
  }

  function emptyState(title, detail = '') {
    return `<div class="empty-state"><strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}</div>`;
  }

  function showNotice(target, message, variant = 'info') {
    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!element) return;
    if (!message) {
      element.hidden = true;
      element.innerHTML = '';
      return;
    }
    element.hidden = false;
    element.innerHTML = `<div class="notice ${variant}">${escapeHtml(message)}</div>`;
  }

  function setBusy(button, busy, busyText = 'Saving…') {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
    }
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
      if (response.status === 401 && !window.location.pathname.endsWith('/login.html')) {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.assign(`/login.html?reason=session&next=${next}`);
      }
      throw new Error(payload?.error || payload?.message || `Request failed (${response.status})`);
    }
    return payload;
  }

  function jsonOptions(method, body) {
    return {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    };
  }

  function populateSelect(select, rows, options = {}) {
    if (!select) return;
    const {
      placeholder = '-- select --',
      value = row => row.id,
      label = row => row.name,
      includeBlank = true
    } = options;
    select.innerHTML = includeBlank ? `<option value="">${escapeHtml(placeholder)}</option>` : '';
    for (const row of rows) {
      const option = document.createElement('option');
      option.value = value(row);
      option.textContent = label(row);
      select.appendChild(option);
    }
  }

  function navMarkup(active, mobile = false) {
    return pages.map(page => `
      <a class="nav-link${active === page.id ? ' active' : ''}" href="${page.href}">
        <span class="nav-icon" aria-hidden="true">${page.icon}</span>
        <span>${page.label}</span>
      </a>
    `).join('');
  }

  async function mountNavigation() {
    const active = document.body.dataset.page || 'dashboard';
    const shell = document.querySelector('.app-shell');
    if (!shell) return;

    try {
      currentUser = await requestJson('/api/auth/me');
    } catch {
      return;
    }

    const sidebar = document.createElement('aside');
    sidebar.className = 'sidebar';
    sidebar.innerHTML = `
      <a class="brand" href="/">
        <span class="brand-mark">CL</span>
        <span class="brand-copy"><strong>Calving Log</strong><span>Milk safety desk</span></span>
      </a>
      <nav class="sidebar-nav" aria-label="Primary navigation">${navMarkup(active)}</nav>
      <div class="sidebar-foot">
        <span class="system-light"></span>${escapeHtml(currentUser.name)} · ${escapeHtml(humanize(currentUser.role))}<br>
        <button class="text-button" id="logout-button" type="button">Sign out</button>
      </div>
    `;
    shell.prepend(sidebar);

    let schemaVersion = '';
    try {
      schemaVersion = (await requestJson('/api/health')).schema_version;
    } catch {
      schemaVersion = '';
    }

    const mobileTopbar = document.createElement('div');
    mobileTopbar.className = 'mobile-topbar';
    mobileTopbar.innerHTML = `<span class="mobile-brand"><span>CL</span> Calving Log</span><span class="mobile-status">${escapeHtml(currentUser.name)}${schemaVersion ? ` · v${escapeHtml(schemaVersion)}` : ''}</span>`;
    const main = shell.querySelector('.app-main');
    main?.prepend(mobileTopbar);

    const prototypeBanner = document.createElement('div');
    prototypeBanner.className = 'prototype-banner';
    prototypeBanner.innerHTML = `
      <strong>Field-test prototype</strong>
      <span>Use demonstration data only. Do not use this site by itself to release milk into the vat.</span>
      <a href="/feedback.html">Give feedback</a>
    `;
    mobileTopbar.after(prototypeBanner);

    const mobileNav = document.createElement('nav');
    mobileNav.className = 'mobile-nav';
    mobileNav.setAttribute('aria-label', 'Mobile navigation');
    mobileNav.innerHTML = navMarkup(active, true);
    document.body.appendChild(mobileNav);
    requestAnimationFrame(() => {
      const activeLink = mobileNav.querySelector('.nav-link.active');
      if (activeLink) {
        mobileNav.scrollLeft = Math.max(
          0,
          activeLink.offsetLeft - ((mobileNav.clientWidth - activeLink.clientWidth) / 2)
        );
      }
    });

    document.getElementById('logout-button')?.addEventListener('click', async () => {
      await requestJson('/api/auth/logout', { method: 'POST' });
      window.location.assign('/login.html');
    });
  }

  window.CalvingLog = {
    badge,
    currentSeason,
    emptyState,
    escapeHtml,
    formatDate,
    getCurrentUser: () => currentUser,
    humanize,
    jsonOptions,
    populateSelect,
    requestJson,
    setBusy,
    showNotice,
    today
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountNavigation);
  } else {
    mountNavigation();
  }
})();
