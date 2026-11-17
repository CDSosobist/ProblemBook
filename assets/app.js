/* =========================================================================
   ProblemBook — реестр проблем ИТ-инфраструктуры
   Чистый JS, без зависимостей. Данные — localStorage + JSON import/export.
   ========================================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------------ константы */

  var STORE_KEY = 'problembook.v1';
  var BACKUP_KEY = 'problembook.backup';

  var PRIORITIES = [
    { id: 'P1', label: 'Критический', sla: 'Реакция в тот же день, эскалация до ИТ-директора.', order: 0 },
    { id: 'P2', label: 'Высокий', sla: 'Реакция до 5 рабочих дней.', order: 1 },
    { id: 'P3', label: 'Средний', sla: 'Реакция до 30 календарных дней.', order: 2 },
    { id: 'P4', label: 'Низкий', sla: 'Бэклог: планово, по возможности.', order: 3 }
  ];

  var STATUSES = [
    { id: 'new', label: 'Новая', order: 0 },
    { id: 'progress', label: 'В работе', order: 1 },
    { id: 'blocked', label: 'Заблокирована', order: 2 },
    { id: 'review', label: 'На проверке', order: 3 },
    { id: 'done', label: 'Решена', order: 4 },
    { id: 'deferred', label: 'Отложена', order: 5 },
    { id: 'rejected', label: 'Отклонена', order: 6 }
  ];

  var CATEGORIES = [
    'Бэкапы и восстановление',
    'Обновления и патчи',
    'Мониторинг и алертинг',
    'Доступы и ИБ',
    'Active Directory',
    'Сеть и DNS',
    'Диски и хранилище',
    'Виртуализация и контейнеры',
    'Базы данных',
    'CI/CD и автоматизация',
    'Документация и регламенты',
    'Люди и процессы',
    'Электропитание и ЦОД',
    'Прочее'
  ];

  /* -------------------------------------------------------------- утилиты */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function uid() {
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function isoNow() { return new Date().toISOString(); }

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function daysFromNow(n) {
    var d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function fmtDate(iso, withYear) {
    if (!iso) return '—';
    var d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
    if (isNaN(d.getTime())) return '—';
    var opts = withYear ? { day: '2-digit', month: 'short', year: 'numeric' } : { day: '2-digit', month: 'short' };
    return new Intl.DateTimeFormat('ru-RU', opts).format(d).replace(' г.', '');
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(d);
  }

  function parseLines(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map(function (line) { return line.replace(/^\s*[-*•—]\s*/, '').trim(); })
      .filter(Boolean);
  }

  function prio(id) {
    for (var i = 0; i < PRIORITIES.length; i++) if (PRIORITIES[i].id === id) return PRIORITIES[i];
    return PRIORITIES[PRIORITIES.length - 1];
  }

  function statusOf(id) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].id === id) return STATUSES[i];
    return STATUSES[0];
  }

  function closedStatus(id) { return id === 'done' || id === 'rejected'; }

  function isOverdue(item) {
    return !!item.due && !closedStatus(item.status) && item.due < todayISO();
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '·';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0].slice(0, 1) + parts[1].slice(0, 1)).toUpperCase();
  }

  function svgIcon(path, extra) {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || '') + '>' + path + '</svg>';
  }

  /* ---------------------------------------------------------------- модель */

  function normalizeItem(raw) {
    var now = isoNow();
    var item = raw && typeof raw === 'object' ? raw : {};
    var actions = Array.isArray(item.actions) ? item.actions.map(String) : parseLines(item.actionsText || item.actions);

    var done = Array.isArray(item.done) ? item.done.filter(function (n) {
      return typeof n === 'number' && n >= 0 && n < actions.length;
    }) : [];

    return {
      id: item.id ? String(item.id) : '',
      title: String(item.title || 'Без названия').trim(),
      category: String(item.category || 'Прочее'),
      priority: prio(item.priority).id,
      status: statusOf(item.status).id,
      owner: String(item.owner || ''),
      assets: String(item.assets || ''),
      risk: String(item.risk || ''),
      actions: actions,
      done: done,
      implRisks: String(item.implRisks || ''),
      notes: String(item.notes || ''),
      due: /^\d{4}-\d{2}-\d{2}$/.test(item.due || '') ? item.due : '',
      effort: item.effort === 0 || item.effort ? Number(item.effort) : null,
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now,
      history: Array.isArray(item.history) ? item.history.filter(function (h) {
        return h && h.ts && h.text;
      }).map(function (h) { return { ts: String(h.ts), text: String(h.text) }; }) : []
    };
  }

  function nextId() {
    var max = 0;
    state.items.forEach(function (item) {
      var m = /(\d+)\s*$/.exec(item.id || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    state.seq = Math.max(state.seq || 0, max) + 1;
    return 'PB-' + state.seq;
  }

  /* ---------------------------------------------------------------- стейт */

  var MODE = 'local';
  var server = {
    user: null, csrf: null, revision: 0, timer: null,
    conflict: null, poll: null, loaded: false
  };

  var state = {
    items: [],
    seq: 0,
    ui: {
      view: 'table',
      sort: 'priority',
      theme: 'dark',
      q: '',
      filters: { status: [], priority: [], category: '', owner: '', overdue: false }
    },
    formMode: 'create',
    editingId: null,
    currentId: null,
    lastDeleted: null
  };

  /* --------------------------------------------------- хранилище / бэкапы */

  function readStore() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORE_KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      banner('Локальные данные повреждены и не были загружены. Импортируйте JSON-бэкап.');
      return null;
    }
  }

  function loadUI() {
    var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    state.ui.theme = prefersLight ? 'light' : 'dark';
    var data = readStore();
    try {
      if (data && data.ui && typeof data.ui === 'object') {
        var ui = data.ui;
        if (ui.view === 'table' || ui.view === 'board') state.ui.view = ui.view;
        if (['priority', 'due', 'updated', 'created', 'title'].indexOf(ui.sort) >= 0) state.ui.sort = ui.sort;
        if (ui.theme === 'light' || ui.theme === 'dark') state.ui.theme = ui.theme;
        if (typeof ui.q === 'string') state.ui.q = ui.q;
        if (ui.filters && typeof ui.filters === 'object') {
          var f = ui.filters;
          if (Array.isArray(f.status)) state.ui.filters.status = f.status.filter(function (s) { return statusOf(s).id === s; });
          if (Array.isArray(f.priority)) state.ui.filters.priority = f.priority.filter(function (p) { return prio(p).id === p; });
          state.ui.filters.category = typeof f.category === 'string' ? f.category : '';
          state.ui.filters.owner = typeof f.owner === 'string' ? f.owner : '';
          state.ui.filters.overdue = !!f.overdue;
        }
      }
    } catch (e) {
      console.warn('ProblemBook: не удалось прочитать локальные данные', e);
    }
  }

  function load() {
    loadUI();
    var data = readStore();
    if (!data && localStorage.getItem(STORE_KEY)) return;
    var items = Array.isArray(data) ? data : (data && data.items) || [];
    state.items = items.map(normalizeItem);
  }

  function writeStore() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        app: 'problembook',
        version: 1,
        savedAt: isoNow(),
        items: state.items,
        ui: state.ui
      }));
    } catch (e) {
      banner('Не удалось сохранить данные в браузере (хранилище переполнено или недоступно). Экспортируйте JSON.');
    }
  }

  function save() {
    writeStore();
    if (MODE === 'server') scheduleSync();
  }

  /* --------------------------------------------------- серверный режим */

  function apiCall(path, options) {
    options = options || {};
    var headers = options.headers || {};
    headers['Accept'] = 'application/json';
    if (options.body) headers['Content-Type'] = 'application/json';
    if (server.csrf) headers['X-CSRF-Token'] = server.csrf;
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body,
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (response.ok) return data;
        var error = new Error((data && data.error) || ('HTTP ' + response.status));
        error.status = response.status;
        error.data = data || {};
        throw error;
      });
    });
  }

  function canWrite() {
    if (MODE !== 'server') return true;
    return !!(server.user && server.user.role !== 'viewer');
  }

  function detectMode() {
    var canProbe = window.fetch && /^https?:$/.test(location.protocol);
    if (!canProbe) { startLocal(); return; }
    apiCall('api/session').then(function (data) {
      if (!data || typeof data.authenticated !== 'boolean') throw new Error('no-api');
      enterServerMode(data);
    }).catch(function () {
      startLocal();
    });
  }

  function startLocal() {
    MODE = 'local';
    load();
    applyTheme();
    renderAll();
  }

  function enterServerMode(data) {
    MODE = 'server';
    document.body.classList.add('mode-server');
    loadUI();
    applyTheme();
    if (!data.authenticated) { showLogin(); renderAll(); return; }
    server.user = data.user;
    server.csrf = data.csrf;
    onAuthenticated();
  }

  function onAuthenticated() {
    if (el.storageNote) {
      el.storageNote.textContent = 'ЭКРОСХИМ · реестр проблем ИТ-инфраструктуры · общий реестр на сервере';
    }
    var readonly = server.user.role === 'viewer';
    document.body.classList.toggle('is-readonly', readonly);
    renderUserChip();
    hideLogin();
    serverLoad();
  }

  function renderUserChip() {
    if (!el.userChip) return;
    if (MODE !== 'server' || !server.user) { el.userChip.hidden = true; return; }
    el.userChip.hidden = false;
    el.userName.textContent = server.user.name;
    el.userRole.textContent = server.user.roleTitle || server.user.role;
    el.userInitial.textContent = initials(server.user.name);
  }

  function serverLoad() {
    apiCall('api/state').then(function (data) {
      state.items = (data.items || []).map(normalizeItem);
      server.revision = data.revision;
      server.loaded = true;
      server.conflict = null;
      hideConflict();
      writeStore();
      renderAll();
      setSyncStatus('ok');
      startPolling();
      if (!state.items.length) return;
    }).catch(function (error) {
      if (error.status === 401) { server.user = null; showLogin(); return; }
      banner('Не удалось загрузить реестр с сервера: ' + error.message);
    });
  }

  function scheduleSync() {
    if (MODE !== 'server' || !server.loaded || !canWrite()) return;
    if (server.conflict) return;
    server.pending = true;
    setSyncStatus('syncing');
    clearTimeout(server.timer);
    server.timer = setTimeout(function () { syncNow(false); }, 700);
  }

  function syncNow(force) {
    if (MODE !== 'server') return;
    clearTimeout(server.timer);
    setSyncStatus('syncing');
    return apiCall('api/state', {
      method: 'PUT',
      body: JSON.stringify({ revision: server.revision, items: state.items, force: !!force })
    }).then(function (data) {
      server.revision = data.revision;
      server.pending = false;
      server.conflict = null;
      hideConflict();
      setSyncStatus('ok');
    }).catch(function (error) {
      server.pending = false;
      if (error.status === 409) {
        server.conflict = error.data || {};
        showConflict(server.conflict);
        setSyncStatus('conflict');
        return;
      }
      if (error.status === 401) { server.user = null; showLogin(); return; }
      setSyncStatus('error', error.message);
      toast('Не удалось сохранить на сервере: ' + error.message, 'danger');
    });
  }

  function setSyncStatus(kind, message) {
    if (!el.syncChip) return;
    if (MODE !== 'server') { el.syncChip.hidden = true; return; }
    el.syncChip.hidden = false;
    el.syncChip.className = 'sync-chip is-' + kind;
    var text = {
      syncing: 'сохраняю…',
      ok: 'сохранено на сервере',
      conflict: 'конфликт версий',
      error: 'ошибка сохранения'
    }[kind] || kind;
    el.syncChip.textContent = message ? text + ': ' + message : text;
    el.syncChip.title = 'Версия реестра: ' + server.revision;
  }

  function showConflict(meta) {
    if (!el.serverBanner) return;
    el.serverBanner.hidden = false;
    el.serverBanner.className = 'server-banner is-warning';
    el.serverBanner.innerHTML = '<div class="server-banner-text">Реестр изменён другим пользователем' +
      (meta && meta.updatedBy ? ' (' + esc(meta.updatedBy) + ')' : '') +
      '. Ваши правки ещё не сохранены — загрузите свежую версию или сохраните поверх.</div>' +
      '<div class="server-banner-actions">' +
      '<button class="btn btn-sm" type="button" data-banner="reload">Загрузить с сервера</button>' +
      '<button class="btn btn-sm btn-danger" type="button" data-banner="force">Сохранить поверх</button>' +
      '</div>';
  }

  function showUpdateNotice() {
    if (!el.serverBanner) return;
    el.serverBanner.hidden = false;
    el.serverBanner.className = 'server-banner';
    el.serverBanner.innerHTML = '<div class="server-banner-text">На сервере есть более свежая версия реестра.</div>' +
      '<div class="server-banner-actions">' +
      '<button class="btn btn-sm" type="button" data-banner="apply">Обновить</button>' +
      '</div>';
  }

  function hideConflict() {
    if (!el.serverBanner) return;
    el.serverBanner.hidden = true;
    el.serverBanner.innerHTML = '';
  }

  function startPolling() {
    stopPolling();
    if (MODE !== 'server') return;
    server.poll = setInterval(function () {
      if (document.hidden || server.pending || server.conflict) return;
      apiCall('api/state').then(function (data) {
        if (data.revision !== server.revision) showUpdateNotice();
      }).catch(function () { /* тихо: следующий цикл */ });
    }, 45000);
  }

  function stopPolling() {
    if (server.poll) { clearInterval(server.poll); server.poll = null; }
  }

  function showLogin() {
    if (!el.loginLayer) return;
    stopPolling();
    el.loginLayer.hidden = false;
    document.body.classList.add('no-scroll');
    if (el.loginName) setTimeout(function () { el.loginName.focus(); }, 60);
  }

  function hideLogin() {
    if (!el.loginLayer) return;
    el.loginLayer.hidden = true;
    document.body.classList.remove('no-scroll');
  }

  function loginError(message) {
    if (!el.loginError) return;
    el.loginError.hidden = !message;
    el.loginError.textContent = message || '';
  }

  function submitLogin(event) {
    if (event) event.preventDefault();
    var name = (el.loginName.value || '').trim();
    var password = el.loginPassword.value || '';
    if (!name || !password) { loginError('Введите логин и пароль'); return; }
    el.loginSubmit.disabled = true;
    loginError('');
    apiCall('api/login', { method: 'POST', body: JSON.stringify({ name: name, password: password }) })
      .then(function (data) {
        server.user = data.user;
        server.csrf = data.csrf;
        el.loginPassword.value = '';
        onAuthenticated();
      })
      .catch(function (error) {
        loginError(error.message || 'Не удалось войти');
        el.loginPassword.select();
      })
      .then(function () { el.loginSubmit.disabled = false; });
  }

  function logout() {
    apiCall('api/logout', { method: 'POST' }).catch(function () { /* всё равно уходим */ })
      .then(function () {
        server.user = null;
        server.csrf = null;
        stopPolling();
        location.reload();
      });
  }

  function pushHistory(item, text) {
    item.history.push({ ts: isoNow(), text: text });
    item.updatedAt = isoNow();
  }

  /* -------------------------------------------------------------- отрисовка */

  var el = {};

  function cacheEls() {
    el.search = $('#search');
    el.statusFilters = $('#statusFilters');
    el.priorityFilters = $('#priorityFilters');
    el.catFilter = $('#catFilter');
    el.ownerFilter = $('#ownerFilter');
    el.overdueFilter = $('#overdueFilter');
    el.resetFilters = $('#resetFilters');
    el.kpiOpen = $('#kpiOpen');
    el.kpiOpenHint = $('#kpiOpenHint');
    el.kpiP1 = $('#kpiP1');
    el.kpiP2 = $('#kpiP2');
    el.kpiInWork = $('#kpiInWork');
    el.kpiInWorkHint = $('#kpiInWorkHint');
    el.kpiOverdue = $('#kpiOverdue');
    el.kpiClosedHint = $('#kpiClosedHint');
    el.viewSwitch = $('#viewSwitch');
    el.sortSelect = $('#sortSelect');
    el.countBadge = $('#countBadge');
    el.tableView = $('#tableView');
    el.boardView = $('#boardView');
    el.tableBody = $('#tableBody');
    el.board = $('#board');
    el.emptyState = $('#emptyState');
    el.drawer = $('#drawer');
    el.drawerBackdrop = $('#drawerBackdrop');
    el.drawerTitle = $('#drawerTitle');
    el.drawerIdLine = $('#drawerIdLine');
    el.drawerBody = $('#drawerBody');
    el.modalLayer = $('#modalLayer');
    el.modalTitle = $('#modalTitle');
    el.itemForm = $('#itemForm');
    el.toasts = $('#toasts');
    el.themeIcon = $('#themeIcon');
    el.loginLayer = $('#loginLayer');
    el.loginForm = $('#loginForm');
    el.loginName = $('#loginName');
    el.loginPassword = $('#loginPassword');
    el.loginError = $('#loginError');
    el.loginSubmit = $('#loginSubmit');
    el.userChip = $('#userChip');
    el.userName = $('#userName');
    el.userRole = $('#userRole');
    el.userInitial = $('#userInitial');
    el.logoutBtn = $('#logoutBtn');
    el.syncChip = $('#syncChip');
    el.storageNote = $('#storageNote');
    el.printMeta = $('#printMeta');
    el.serverBanner = $('#serverBanner');
  }

  function updatePrintMeta() {
    if (!el.printMeta) return;
    var open = 0;
    var critical = 0;
    state.items.forEach(function (item) {
      if (!closedStatus(item.status)) {
        open++;
        if (item.priority === 'P1') critical++;
      }
    });
    var parts = ['сформирован ' + fmtDate(todayISO(), true), 'проблем в реестре: ' + state.items.length,
                 'открытых: ' + open, 'критичных P1: ' + critical];
    if (MODE === 'server' && server.user) parts.push('выгрузил: ' + server.user.name);
    el.printMeta.textContent = parts.join(' · ');
  }

  function renderAll() {
    renderFilters();
    renderKpi();
    renderList();
    renderToolbar();
    updatePrintMeta();
  }

  /* ---------- сайдбар ---------- */

  function renderFilters() {
    var f = state.ui.filters;

    el.statusFilters.innerHTML = STATUSES.map(function (s) {
      var count = state.items.filter(function (i) { return i.status === s.id; }).length;
      var on = f.status.indexOf(s.id) >= 0;
      return '<button type="button" class="chip' + (on ? ' is-active' : '') + '" data-status="' + s.id + '" aria-pressed="' + on + '">' +
        '<span class="dot badge-status ' + s.id + '"></span>' + esc(s.label) +
        '<span class="count">' + count + '</span></button>';
    }).join('');

    el.priorityFilters.innerHTML = PRIORITIES.map(function (p) {
      var count = state.items.filter(function (i) { return i.priority === p.id; }).length;
      var on = f.priority.indexOf(p.id) >= 0;
      return '<button type="button" class="chip' + (on ? ' is-active' : '') + '" data-priority="' + p.id + '" aria-pressed="' + on + '" title="' + esc(p.label + '. ' + p.sla) + '">' +
        '<span class="dot" style="background:var(--' + p.id.toLowerCase() + ')"></span>' + p.id +
        '<span class="count">' + count + '</span></button>';
    }).join('');

    var cats = CATEGORIES.slice();
    state.items.forEach(function (i) {
      if (i.category && cats.indexOf(i.category) < 0) cats.push(i.category);
    });
    el.catFilter.innerHTML = '<option value="">Все категории</option>' + cats.map(function (c) {
      return '<option value="' + esc(c) + '"' + (f.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');

    var owners = {};
    state.items.forEach(function (i) { if (i.owner) owners[i.owner] = true; });
    var ownerNames = Object.keys(owners).sort(function (a, b) { return a.localeCompare(b, 'ru'); });
    el.ownerFilter.innerHTML = '<option value="">Все ответственные</option>' + ownerNames.map(function (o) {
      return '<option value="' + esc(o) + '"' + (f.owner === o ? ' selected' : '') + '>' + esc(o) + '</option>';
    }).join('');

    el.overdueFilter.checked = f.overdue;
  }

  /* ---------- KPI ---------- */

  function renderKpi() {
    var total = state.items.length;
    var open = 0, p1 = 0, p2 = 0, inWork = 0, overdue = 0, closed = 0;

    state.items.forEach(function (i) {
      var isClosed = closedStatus(i.status);
      if (!isClosed) {
        open++;
        if (i.priority === 'P1') p1++;
        if (i.priority === 'P2') p2++;
      }
      if (i.status === 'progress') inWork++;
      if (isClosed) closed++;
      if (isOverdue(i)) overdue++;
    });

    el.kpiOpen.textContent = open;
    el.kpiOpenHint.textContent = 'из ' + total + ' всего';
    el.kpiP1.textContent = p1;
    el.kpiP2.textContent = p2;
    el.kpiInWork.textContent = inWork;
    el.kpiInWorkHint.textContent = inWork ? 'выполняются сейчас' : 'нет активных';
    el.kpiOverdue.textContent = overdue;
    el.kpiClosedHint.textContent = 'решено/закрыто: ' + closed;
  }

  /* ---------- список ---------- */

  function haystack(item) {
    return [
      item.id, item.title, item.risk, item.owner, item.assets, item.notes,
      item.implRisks, item.category, prio(item.priority).label, statusOf(item.status).label
    ].concat(item.actions).join(' ').toLowerCase();
  }

  function visibleItems() {
    var f = state.ui.filters;
    var q = (state.ui.q || '').trim().toLowerCase();
    var list = state.items.slice();

    if (f.status.length) list = list.filter(function (i) { return f.status.indexOf(i.status) >= 0; });
    if (f.priority.length) list = list.filter(function (i) { return f.priority.indexOf(i.priority) >= 0; });
    if (f.category) list = list.filter(function (i) { return i.category === f.category; });
    if (f.owner) list = list.filter(function (i) { return i.owner === f.owner; });
    if (f.overdue) list = list.filter(isOverdue);
    if (q) list = list.filter(function (i) { return haystack(i).indexOf(q) >= 0; });

    var sort = state.ui.sort;
    list.sort(function (a, b) {
      if (sort === 'due') {
        if (!a.due && !b.due) return prio(a.priority).order - prio(b.priority).order;
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
      }
      if (sort === 'updated') return (b.updatedAt || '').localeCompare(a.updatedAt || '');
      if (sort === 'created') return (b.createdAt || '').localeCompare(a.createdAt || '');
      if (sort === 'title') return a.title.localeCompare(b.title, 'ru');
      var d = prio(a.priority).order - prio(b.priority).order;
      if (d) return d;
      if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
      if (a.due && !b.due) return -1;
      if (!a.due && b.due) return 1;
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });

    return list;
  }

  function prioBadge(p) {
    var pc = prio(p);
    return '<span class="badge badge-prio ' + pc.id.toLowerCase() + '" title="' + esc(pc.label + '. ' + pc.sla) + '">' +
      pc.id + ' · ' + esc(pc.label) + '</span>';
  }

  function statusBadge(s) {
    var sc = statusOf(s);
    return '<span class="badge badge-status ' + sc.id + '"><span class="dot"></span>' + esc(sc.label) + '</span>';
  }

  function rowHtml(item) {
    var sub = [];
    if (item.category) sub.push('<span class="tag tag-cat">' + esc(item.category) + '</span>');
    if (item.assets) sub.push('<span class="tag">' + esc(item.assets) + '</span>');
    if (item.actions.length) sub.push('<span class="tag">' + item.done.length + '/' + item.actions.length + ' действий</span>');
    if (isOverdue(item)) sub.push('<span class="tag" style="color:var(--danger);border-color:color-mix(in srgb, var(--danger) 40%, transparent)">просрочено</span>');

    return '<tr data-id="' + esc(item.id) + '" tabindex="0">' +
      '<td class="cell-id">' + esc(item.id) + '</td>' +
      '<td>' + prioBadge(item.priority) + '</td>' +
      '<td class="cell-title"><span class="t">' + esc(item.title) + '</span>' +
        (sub.length ? '<div class="sub">' + sub.join('') + '</div>' : '') +
      '</td>' +
      '<td class="cell-risk"><div class="clamp" title="' + esc(item.risk) + '">' + (esc(item.risk) || '<span style="color:var(--muted-2)">не описан</span>') + '</div></td>' +
      '<td>' + statusBadge(item.status) + '</td>' +
      '<td class="cell-owner">' + (item.owner
        ? '<span class="avatar">' + esc(initials(item.owner)) + '</span>' + esc(item.owner)
        : '<span style="color:var(--muted-2)">Не назначен</span>') + '</td>' +
      '<td class="cell-due' + (isOverdue(item) ? ' is-overdue' : '') + '">' + esc(fmtDate(item.due)) + '</td>' +
      '<td class="cell-id">' + esc(fmtDate(item.updatedAt)) + '</td>' +
      '</tr>';
  }

  function cardHtml(item) {
    var pc = prio(item.priority);
    return '<article class="card" draggable="true" data-drag-id="' + esc(item.id) + '" data-id="' + esc(item.id) + '" tabindex="0" style="--card-accent: var(--' + pc.id.toLowerCase() + ')">' +
      '<div class="card-top">' + prioBadge(item.priority) +
        '<span class="card-id">' + esc(item.id) + '</span></div>' +
      '<span class="card-title">' + esc(item.title) + '</span>' +
      '<div class="card-meta">' +
        (item.owner ? '<span>' + esc(item.owner) + '</span>' : '<span>Не назначен</span>') +
        (item.due ? '<span class="' + (isOverdue(item) ? 'overdue' : '') + '">· ' + esc(fmtDate(item.due)) + '</span>' : '') +
        (isOverdue(item) ? '<span class="overdue">просрочено</span>' : '') +
      '</div>' +
      '</article>';
  }

  function renderList() {
    var list = visibleItems();
    var total = state.items.length;

    el.countBadge.textContent = total === 0 ? '0 записей' : list.length + ' из ' + total;

    el.tableView.hidden = state.ui.view !== 'table';
    el.boardView.hidden = state.ui.view !== 'board';

    if (total === 0) {
      el.tableView.hidden = true;
      el.boardView.hidden = true;
      el.emptyState.hidden = false;
      el.emptyState.innerHTML = emptyMarkup();
      return;
    }

    el.emptyState.hidden = list.length !== 0;
    if (list.length === 0) {
      el.tableView.hidden = true;
      el.boardView.hidden = true;
      el.emptyState.innerHTML = ''
        + '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">'
        + '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>'
        + '<h3>Ничего не найдено</h3>'
        + '<p>Под текущие фильтры не попадает ни одна проблема. Ослабьте условия или сбросьте фильтры.</p>'
        + '<div class="empty-actions"><button class="btn btn-primary" type="button" data-action="reset-filters">Сбросить фильтры</button></div>';
      return;
    }

    el.tableBody.innerHTML = list.map(rowHtml).join('');

    var cols = state.ui.view === 'board' ? visibleBoardStatuses(list) : STATUSES;
    el.board.style.gridTemplateColumns = 'repeat(' + Math.max(1, cols.length) + ', minmax(252px, 1fr))';
    el.board.innerHTML = cols.map(function (s) {
      var inCol = list.filter(function (i) { return i.status === s.id; });
      return '<section class="col" data-col-status="' + s.id + '">' +
        '<header class="col-head">' +
          '<span class="dot" style="color:var(--' + (s.id === 'new' ? 'accent' : 'p' + (1 + (s.order % 4))) + ')"></span>' +
          '<span class="name">' + esc(s.label) + '</span>' +
          '<span class="count">' + inCol.length + '</span>' +
        '</header>' +
        '<div class="col-body">' + (inCol.length ? inCol.map(cardHtml).join('') : '<div class="col-empty" style="padding:6px 4px;font-size:12px;color:var(--muted-2)">пусто</div>') + '</div>' +
        '</section>';
    }).join('');
  }

  function visibleBoardStatuses(list) {
    return STATUSES.filter(function (s) {
      return list.some(function (i) { return i.status === s.id; }) || s.id === 'new' || s.id === 'progress';
    });
  }

  function emptyMarkup() {
    return ''
      + '<svg width="88" height="88" viewBox="0 0 24 24" fill="none" stroke="url(#g)" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#00875c"/><stop offset="100%" stop-color="#33d19a"/></linearGradient></defs>'
      + '<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/>'
      + '<path d="M14 3v5h5"/><path d="M9.5 13h6M9.5 16.5h4"/></svg>'
      + '<h3>Проблембук пуст</h3>'
      + '<p>Здесь будет реестр проблем инфраструктуры: что сломано, чем это грозит, что делать, чем рискуем при починке, приоритет и статус. Начните с первой записи — или посмотрите демо-примеры.</p>'
      + '<div class="empty-actions">'
      + '<button class="btn btn-primary" type="button" data-action="new">+ Добавить первую проблему</button>'
      + '<button class="btn btn-ghost" type="button" data-action="demo">Загрузить демо-примеры (10)</button>'
      + '</div>';
  }

  function renderToolbar() {
    $$('#viewSwitch button').forEach(function (b) {
      var active = b.getAttribute('data-view') === state.ui.view;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    el.sortSelect.value = state.ui.sort;
    if (el.search.value !== state.ui.q) el.search.value = state.ui.q;
  }

  /* ------------------------------------------------------------- карточка */

  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }

  function openDrawer(id) {
    var item = findItem(id);
    if (!item) return;
    state.currentId = id;
    renderDrawer(item);
    el.drawer.classList.add('is-open');
    el.drawer.setAttribute('aria-hidden', 'false');
    el.drawerBackdrop.classList.add('is-open');
    document.body.classList.add('no-scroll');
  }

  function closeDrawer() {
    state.currentId = null;
    el.drawer.classList.remove('is-open');
    el.drawer.setAttribute('aria-hidden', 'true');
    el.drawerBackdrop.classList.remove('is-open');
    document.body.classList.remove('no-scroll');
  }

  function section(title, bodyHtml, muted) {
    if (!bodyHtml) return '';
    return '<div class="section"><div class="section-head"><h4>' + esc(title) + '</h4><span class="line"></span></div>' +
      '<div class="section-body' + (muted ? ' is-muted' : '') + '">' + bodyHtml + '</div></div>';
  }

  function renderDrawer(item) {
    var pc = prio(item.priority);

    el.drawerIdLine.innerHTML =
      '<span class="cell-id">' + esc(item.id) + '</span>' + prioBadge(item.priority) + statusBadge(item.status) +
      (isOverdue(item) ? '<span class="badge" style="color:var(--danger);border-color:color-mix(in srgb, var(--danger) 40%, transparent)">просрочено</span>' : '');
    el.drawerTitle.textContent = item.title;

    var actionsDone = item.done.length;
    var actionsTotal = item.actions.length;
    var checklist = actionsTotal
      ? '<div class="checklist">' + item.actions.map(function (a, idx) {
          var done = item.done.indexOf(idx) >= 0;
          return '<label class="check-item' + (done ? ' is-done' : '') + '">' +
            '<input type="checkbox" data-check="' + idx + '"' + (done ? ' checked' : '') + '>' +
            '<span>' + esc(a) + '</span></label>';
        }).join('') + '</div>'
      : '<div class="section-body is-muted" style="padding:0">Пока не сформулированы.</div>';

    var meta = ''
      + '<div class="meta-item"><span class="k">Категория</span><span class="v">' + esc(item.category || '—') + '</span></div>'
      + '<div class="meta-item"><span class="k">Ответственный</span><span class="v">' + esc(item.owner || 'Не назначен') + '</span></div>'
      + '<div class="meta-item"><span class="k">Системы / хосты</span><span class="v">' + esc(item.assets || '—') + '</span></div>'
      + '<div class="meta-item"><span class="k">Срок</span><span class="v"' + (isOverdue(item) ? ' style="color:var(--danger);font-weight:700"' : '') + '>' + esc(fmtDate(item.due, true)) + '</span></div>'
      + '<div class="meta-item"><span class="k">Трудозатраты</span><span class="v">' + (item.effort ? esc(item.effort) + ' ч/д' : '—') + '</span></div>'
      + '<div class="meta-item"><span class="k">SLA приоритета</span><span class="v">' + esc(pc.sla) + '</span></div>';

    el.drawerBody.innerHTML = ''
      + '<div class="section">'
      +   '<div class="section-head"><h4>Статус</h4><span class="line"></span></div>'
      +   '<select id="drawerStatus">' + STATUSES.map(function (s) {
            return '<option value="' + s.id + '"' + (s.id === item.status ? ' selected' : '') + '>' + esc(s.label) + '</option>';
          }).join('') + '</select>'
      + '</div>'
      + section('Риск от проблемы', esc(item.risk) || '<span style="color:var(--muted-2)">Риск не описан — это первое, что стоит сделать.</span>')
      + '<div class="section"><div class="section-head"><h4>Необходимые действия</h4><span class="line"></span>' +
        (actionsTotal ? '<span class="tag">' + actionsDone + '/' + actionsTotal + '</span>' : '') + '</div>' + checklist + '</div>'
      + section('Риски при реализации', esc(item.implRisks) || '<span style="color:var(--muted-2)">Не описаны.</span>')
      + section('Примечания', esc(item.notes) || '<span style="color:var(--muted-2)">Пусто.</span>')
      + '<div class="section"><div class="section-head"><h4>Детали</h4><span class="line"></span></div><div class="meta-grid">' + meta + '</div></div>'
      + '<div class="section"><div class="section-head"><h4>История</h4><span class="line"></span></div>' +
        '<div class="history">' + (item.history.length
          ? item.history.slice().reverse().map(function (h) {
              return '<div class="history-item"><b>' + esc(h.text) + '</b><time>' + esc(fmtDateTime(h.ts)) + '</time></div>';
            }).join('')
          : '<div class="history-item">Записей пока нет</div>') + '</div></div>';

    var statusSelect = $('#drawerStatus', el.drawerBody);
    if (statusSelect && !canWrite()) statusSelect.disabled = true;
    if (statusSelect) {
      statusSelect.addEventListener('change', function () {
        updateItem(item.id, { status: statusSelect.value, _historyText: 'Статус → ' + statusOf(statusSelect.value).label });
      });
    }
    $$('[data-check]', el.drawerBody).forEach(function (box) {
      box.addEventListener('change', function () {
        toggleAction(item.id, parseInt(box.getAttribute('data-check'), 10), box.checked);
      });
    });
  }

  /* ------------------------------------------------------------------ CRUD */

  function createItem(data) {
    if (!canWrite()) return null;
    var item = normalizeItem(data);
    item.id = nextId();
    item.createdAt = isoNow();
    item.updatedAt = item.createdAt;
    item.history = [{ ts: item.createdAt, text: 'Проблема создана' }];
    state.items.unshift(item);
    persistAndRender();
    toast('Проблема ' + item.id + ' добавлена в реестр', 'ok');
    return item;
  }

  function updateItem(id, patch, silent) {
    if (!canWrite()) return;
    var item = findItem(id);
    if (!item) return;
    var statusChanged = !!patch.status && patch.status !== item.status;
    Object.keys(patch).forEach(function (key) {
      if (key === '_historyText' || key === 'status') return;
      item[key] = patch[key];
    });
    if (patch.status) item.status = patch.status;
    pushHistory(item, patch._historyText ||
      (statusChanged ? 'Статус → ' + statusOf(item.status).label : 'Карточка обновлена'));
    if (statusChanged && !silent) toast('Статус: ' + statusOf(item.status).label + ' · ' + item.id, 'ok');
    persistAndRender();
    if (state.currentId === id) {
      var fresh = findItem(id);
      if (fresh) renderDrawer(fresh);
    }
  }

  function toggleAction(id, idx, checked) {
    if (!canWrite()) return;
    var item = findItem(id);
    if (!item) return;
    var done = item.done.indexOf(idx);
    if (checked && done < 0) item.done.push(idx);
    if (!checked && done >= 0) item.done.splice(done, 1);
    pushHistory(item, (checked ? 'Выполнено действие: ' : 'Снята отметка: ') + (item.actions[idx] || ''));
    persistAndRender();
    if (state.currentId === id) renderDrawer(item);
  }

  function deleteItem(id) {
    if (!canWrite()) return;
    var idx = state.items.findIndex(function (i) { return i.id === id; });
    if (idx < 0) return;
    if (!window.confirm('Удалить проблему ' + id + '? Это действие можно отменить кнопкой «Отменить» в уведомлении.')) return;
    state.lastDeleted = { item: state.items[idx], index: idx };
    state.items.splice(idx, 1);
    closeDrawer();
    persistAndRender();
    toast('Удалено: ' + id, 'danger', {
      label: 'Отменить',
      onClick: function () {
        var restored = state.lastDeleted;
        if (!restored) return;
        state.items.splice(Math.min(restored.index, state.items.length), 0, restored.item);
        state.lastDeleted = null;
        persistAndRender();
        toast('Восстановлено ' + restored.item.id, 'ok');
      }
    });
  }

  function duplicateItem(id) {
    if (!canWrite()) return;
    var src = findItem(id);
    if (!src) return;
    var copy = JSON.parse(JSON.stringify(src));
    copy.title = src.title + ' (копия)';
    copy.id = '';
    var created = createItem(copy);
    pushHistory(created, 'Создана копия ' + src.id);
    persistAndRender();
    closeDrawer();
    openDrawer(created.id);
  }

  function persistAndRender() {
    save();
    renderAll();
  }

  /* ---------------------------------------------------------------- форма */

  function fillSelect(select, options) {
    select.innerHTML = options.map(function (o) {
      return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>';
    }).join('');
  }

  function initFormSelects() {
    fillSelect($('#f-priority'), PRIORITIES.map(function (p) {
      return { value: p.id, label: p.id + ' · ' + p.label };
    }));
    fillSelect($('#f-status'), STATUSES.map(function (s) {
      return { value: s.id, label: s.label };
    }));
    $('#f-priority').addEventListener('change', updateSlaHint);
    updateSlaHint();
  }

  /* категории: базовый справочник + то, что уже встречается в реестре */
  function fillCategoryOptions(current) {
    var cats = CATEGORIES.slice();
    if (current && cats.indexOf(current) < 0) cats.push(current);
    state.items.forEach(function (i) {
      if (i.category && cats.indexOf(i.category) < 0) cats.push(i.category);
    });
    fillSelect($('#f-category'), cats.map(function (c) {
      return { value: c, label: c };
    }));
    if (current) $('#f-category').value = current;
  }

  function updateSlaHint() {
    var p = prio($('#f-priority').value);
    $('#f-priority-hint').textContent = 'SLA: ' + p.sla;
  }

  function openForm(item) {
    if (!canWrite()) { toast('Роль «только чтение»: изменения недоступны', 'danger'); return; }
    state.formMode = item ? 'edit' : 'create';
    state.editingId = item ? item.id : null;
    el.modalTitle.textContent = item ? 'Редактировать ' + item.id : 'Новая проблема';
    $('#modalSubmit').textContent = item ? 'Сохранить изменения' : 'Добавить в реестр';

    var src = item || {
      title: '', category: 'Прочее', priority: 'P3', status: 'new', owner: '', assets: '',
      risk: '', actions: [], implRisks: '', notes: '', due: '', effort: null
    };

    fillCategoryOptions(src.category || 'Прочее');
    $('#f-title').value = src.title || '';
    $('#f-priority').value = src.priority || 'P3';
    $('#f-status').value = src.status || 'new';
    $('#f-category').value = src.category || 'Прочее';
    $('#f-risk').value = src.risk || '';
    $('#f-actions').value = (src.actions || []).map(function (a, i) {
      return (item && src.done && src.done.indexOf(i) >= 0 ? '[x] ' : '') + a;
    }).join('\n');
    $('#f-implRisks').value = src.implRisks || '';
    $('#f-owner').value = src.owner || '';
    $('#f-assets').value = src.assets || '';
    $('#f-due').value = src.due || '';
    $('#f-effort').value = src.effort == null ? '' : src.effort;
    $('#f-notes').value = src.notes || '';

    $('#f-title-wrap').classList.remove('invalid');
    $('#f-title-hint').textContent = 'Коротко и по делу: что именно не так в инфраструктуре.';

    updateSlaHint();
    el.modalLayer.hidden = false;
    document.body.classList.add('no-scroll');
    setTimeout(function () { $('#f-title').focus(); }, 30);
  }

  function closeForm() {
    el.modalLayer.hidden = true;
    document.body.classList.remove('no-scroll');
    state.editingId = null;
  }

  function submitForm(event) {
    event.preventDefault();

    var title = $('#f-title').value.trim();
    if (!title) {
      $('#f-title-wrap').classList.add('invalid');
      $('#f-title-hint').textContent = 'Без названия проблему не найти через месяц. Заполните поле.';
      $('#f-title').focus();
      return;
    }

    var rawActions = parseLines($('#f-actions').value);
    var doneIdx = [];
    var actions = rawActions.map(function (line, idx) {
      if (/^\[x\]\s*/i.test(line)) {
        doneIdx.push(idx);
        return line.replace(/^\[x\]\s*/i, '');
      }
      return line.replace(/^\[\s\]\s*/, '');
    });

    var effortRaw = $('#f-effort').value;
    var payload = {
      title: title,
      category: $('#f-category').value,
      priority: $('#f-priority').value,
      status: $('#f-status').value,
      owner: $('#f-owner').value.trim(),
      assets: $('#f-assets').value.trim(),
      risk: $('#f-risk').value.trim(),
      actions: actions,
      done: doneIdx,
      implRisks: $('#f-implRisks').value.trim(),
      notes: $('#f-notes').value.trim(),
      due: $('#f-due').value || '',
      effort: effortRaw === '' ? null : Number(effortRaw)
    };

    if (state.formMode === 'edit' && state.editingId) {
      var existing = findItem(state.editingId);
      if (existing) {
        payload._historyText = existing.status !== payload.status
          ? 'Статус → ' + statusOf(payload.status).label
          : existing.priority !== payload.priority
            ? 'Приоритет → ' + payload.priority
            : 'Карточка отредактирована';
        var keepId = existing.id;
        updateItem(keepId, payload, true);
        toast('Изменения сохранены: ' + keepId, 'ok');
        closeForm();
        return;
      }
    }

    var created = createItem(payload);
    closeForm();
    openDrawer(created.id);
  }

  /* ------------------------------------------------------- экспорт/импорт */

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function stamp() {
    return new Date().toISOString().slice(0, 10);
  }

  function exportJson() {
    if (!state.items.length) { toast('Реестр пуст — экспортировать нечего'); return; }
    download('problembook-' + stamp() + '.json', JSON.stringify({
      app: 'problembook',
      version: 1,
      exportedAt: isoNow(),
      items: state.items
    }, null, 2));
    toast('Экспортировано ' + state.items.length + ' записей', 'ok');
  }

  function csvCell(value) {
    var s = value == null ? '' : String(value);
    return '"' + s.replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  }

  function exportCsv() {
    if (!state.items.length) { toast('Реестр пуст — выгружать нечего'); return; }
    var head = ['ID', 'Проблема', 'Категория', 'Приоритет', 'Статус', 'Ответственный', 'Системы',
      'Риск от проблемы', 'Необходимые действия', 'Риски при реализации', 'Срок', 'Трудозатраты ч/д',
      'Примечания', 'Создано', 'Обновлено'];
    var rows = state.items.map(function (i) {
      return [
        i.id, i.title, i.category, i.priority + ' ' + prio(i.priority).label, statusOf(i.status).label,
        i.owner, i.assets, i.risk,
        i.actions.map(function (a, idx) { return (i.done.indexOf(idx) >= 0 ? '[x] ' : '[ ] ') + a; }).join(' | '),
        i.implRisks, i.due, i.effort == null ? '' : i.effort, i.notes, i.createdAt, i.updatedAt
      ].map(csvCell).join(';');
    });
    download('problembook-' + stamp() + '.csv', '\ufeff' + [head.map(csvCell).join(';')].concat(rows).join('\r\n'), 'text/csv;charset=utf-8');
    toast('CSV выгружен', 'ok');
  }

  function importFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (e) {
        toast('Не удалось прочитать JSON: файл повреждён', 'danger');
        return;
      }
      var items = Array.isArray(parsed) ? parsed : (parsed && parsed.items) || null;
      if (!Array.isArray(items) || !items.length) {
        toast('В файле нет записей проблем', 'danger');
        return;
      }
      if (MODE === 'server') { serverImport(items); return; }
      var incoming = items.map(normalizeItem);
      var msg = 'Импорт заменит текущий реестр (' + state.items.length + ' записей) на ' + incoming.length +
        ' записей из файла.\n\nТекущие данные сохранятся как резервная копия в браузере (кнопка «Отменить» не сработает — сделайте экспорт, если сомневаетесь).\n\nПродолжить?';
      if (!window.confirm(msg)) return;

      try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ savedAt: isoNow(), items: state.items })); } catch (e) { /* ignore */ }

      state.items = incoming.map(function (item, idx) {
        if (!item.id) item.id = 'PB-' + (idx + 1);
        return item;
      });
      state.seq = 0;
      persistAndRender();
      closeDrawer();
      toast('Импортировано ' + incoming.length + ' записей', 'ok');
    };
    reader.onerror = function () { toast('Не удалось прочитать файл', 'danger'); };
    reader.readAsText(file);
  }

  function serverImport(items) {
    if (!canWrite()) { toast('Роль «только чтение»: импорт недоступен', 'danger'); return; }
    if (!window.confirm('Импорт заменит общий реестр на сервере (' + items.length + ' записей).\n\nПродолжить?')) return;
    apiCall('api/import', { method: 'POST', body: JSON.stringify({ items: items }) })
      .then(function (data) {
        toast('Импортировано на сервер: ' + data.count + ' записей', 'ok');
        serverLoad();
        closeDrawer();
      })
      .catch(function (error) {
        toast('Импорт не выполнен: ' + error.message, 'danger');
      });
  }

  function clearAll() {
    if (!canWrite()) { toast('Роль «только чтение»: изменения недоступны', 'danger'); return; }
    if (!state.items.length) { toast('Реестр уже пуст'); return; }
    if (!window.confirm('Удалить все ' + state.items.length + ' записей? Резервная копия останется в браузере, но лучше сделать экспорт JSON.')) return;
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ savedAt: isoNow(), items: state.items })); } catch (e) { /* ignore */ }
    state.items = [];
    state.seq = 0;
    closeDrawer();
    persistAndRender();
    toast('Реестр очищен', 'danger');
  }

  /* ------------------------------------------------------------------ тосты */

  function toast(message, kind, action) {
    var node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.innerHTML = '<span class="msg">' + esc(message) + '</span>';
    if (action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      btn.addEventListener('click', function () {
        action.onClick();
        remove();
      });
      node.appendChild(btn);
    }
    el.toasts.appendChild(node);

    var timer = setTimeout(remove, action ? 8000 : 4200);
    function remove() {
      clearTimeout(timer);
      if (!node.parentNode) return;
      node.classList.add('out');
      setTimeout(function () { node.remove(); }, 170);
    }
    return remove;
  }

  function banner(text) {
    var node = $('#errBanner');
    node.hidden = false;
    node.textContent = text;
  }

  /* ------------------------------------------------------------------ тема */

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.ui.theme);
    var dark = state.ui.theme === 'dark';
    el.themeIcon.innerHTML = dark
      ? '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>'
      : '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"></path>';
  }

  /* ------------------------------------------------------- демо-наполнение */

  function demoItems() {
    return [
      {
        title: 'Восстановление из резервных копий ни разу не проверялось',
        category: 'Бэкапы и восстановление', priority: 'P1', status: 'new', owner: 'Инфраструктура',
        assets: 'SRV-FS-01, SRV-SQL-01, хранилище Veeam',
        risk: 'Фактический RTO/RPO неизвестен. При потере данных восстановление может занять дни или не сработать вовсе: копии лежат на том же СХД, что и прод, и делаются без проверки целостности.',
        actions: [
          'Провести тестовое восстановление файлового сервера и базы в изолированном окружении',
          'Зафиксировать фактический RTO/RPO и утвердить регламент у бизнеса',
          'Вынести копии на отдельный носитель или площадку (правило 3-2-1)',
          'Настроить ежедневную проверку успешности заданий и уведомления об ошибках'
        ],
        done: [0],
        implRisks: 'Тестовое восстановление нагружает прод-хранилище — нужен отдельный стенд. Проверка может вскрыть битые копии, тогда потребуется срочное окно на изменение схемы резервирования.',
        notes: 'Первый шаг — согласовать окно с владельцем сервиса. Копии на том же СХД, что и данные, — красный флаг.',
        due: daysFromNow(7), effort: 5
      },
      {
        title: 'Обновления Windows и офисного ПО не устанавливаются регулярно',
        category: 'Обновления и патчи', priority: 'P1', status: 'progress', owner: 'Инфраструктура',
        assets: 'все серверы и АРМ',
        risk: 'Известные уязвимости ОС и приложений остаются незакрытыми годами. Подрядчики и удалённые сотрудники ходят по RDP и VPN с устаревшими клиентами. Требования аудита и страхования ИБ не выполняются.',
        actions: [
          'Собрать инвентарь: версии ОС и прикладного ПО по всем серверам и АРМ',
          'Настроить WSUS и групповые политики: критичные обновления — автоматически',
          'Составить график окон обслуживания и перезагрузок серверов',
          'Отдельно решить судьбу устаревших ОС (Windows Server 2012 R2, Windows 7/8.1 — вне поддержки)'
        ],
        implRisks: 'Обновления могут ломать учётную систему и кассовое ПО. Нужен пилот на тестовом контуре, точка восстановления и план отката; риск «сломать в пятницу вечером» реален.',
        notes: 'Уточнить у владельцев приложений, кто отвечает за тестирование после обновления.',
        due: daysFromNow(10), effort: 8
      },
      {
        title: 'Мониторинга нет: о сбоях узнаём от пользователей',
        category: 'Мониторинг и алертинг', priority: 'P2', status: 'new', owner: 'Инфраструктура',
        assets: 'все серверы и сервисы',
        risk: 'Авария обнаруживается по звонку, MTTR измеряется часами. Нет истории метрик — невозможно понять, деградация это или пик, и доказать причину сбоя заказчику.',
        actions: [
          'Развернуть систему мониторинга (Zabbix или PRTG) с агентами и опросом по WMI',
          'Минимальный набор алертов: диск >85%, недоступность службы, ошибки бэкапов, перезагрузка сервера, срок действия сертификатов и лицензий',
          'Маршрутизация уведомлений в почту и мессенджер с дежурством',
          'Дашборды: серверы, база, файловые ресурсы, контроллеры домена'
        ],
        implRisks: 'Риск «шторма алертов» в первые недели — их начнут игнорировать. Начать с малого набора и подкрутить пороги в течение месяца.',
        notes: 'Без мониторинга остальные пункты проблембука невозможно измерять — приоритет высокий.',
        due: daysFromNow(21), effort: 6
      },
      {
        title: 'Все админы работают под одной доменной учёткой администратора, MFA нигде нет',
        category: 'Доступы и ИБ', priority: 'P1', status: 'blocked', owner: 'ИБ',
        assets: 'контроллер домена, VPN, серверы по RDP',
        risk: 'Одна учётная запись на всех: нет персональной ответственности, а утечка пароля даёт полный доступ ко всей инфраструктуре. Вход по RDP из интернета без второго фактора — типовая точка входа для шифровальщиков.',
        actions: [
          'Завести персональные учётные записи и отдельные админские аккаунты для привилегированных задач',
          'Ограничить администраторов группами Protected Users, включить LAPS для локальных админов',
          'Включить MFA на VPN, RDP-шлюзе и почте',
          'Закрыть RDP из интернета, оставить доступ только через VPN; включить журналирование входов'
        ],
        implRisks: 'Смена модели доступа может «отрезать» админа от сервера и парализовать работу. Делать поэтапно, держать аварийный доступ через консоль или IPMI и второго администратора.',
        notes: 'Заблокировано: ждём согласования с подрядчиком по VPN и закупку токенов.',
        due: daysFromNow(3), effort: 4
      },
      {
        title: 'Диск C: на файловом сервере заполнен на 96%, чистка вручную',
        category: 'Диски и хранилище', priority: 'P2', status: 'progress', owner: 'Дежурная смена',
        assets: 'SRV-FS-01',
        risk: 'При заполнении диска останавливаются службы, перестают писаться журналы и не запускается база. Каждый раз чистим вручную — и рискуем удалить журналы, нужные для разбора инцидента.',
        actions: [
          'Найти крупнейшие каталоги и файлы, выгрузить старые архивы на отдельный том',
          'Настроить квоты на общие папки и лимиты на профили пользователей',
          'Включить ротацию журналов приложений и очистку временных каталогов по расписанию',
          'Добавить алерты на 85% и 92%'
        ],
        implRisks: 'Агрессивная чистка может удалить данные, к которым обращаются пользователи. Сначала выгрузка и проверка, только потом удаление; квоты вводить после разъяснения сотрудникам.',
        notes: 'Диск 200 ГБ, 40 ГБ занимают старые архивы релизов — отдельная задача на выгрузку.',
        due: daysFromNow(2), effort: 1.5
      },
      {
        title: 'Нет реестра серверов, АРМ, лицензий и доступов — всё «в голове» одного админа',
        category: 'Документация и регламенты', priority: 'P2', status: 'new', owner: 'ИТ-директор',
        assets: 'вся инфраструктура',
        risk: 'Bus factor = 1. Увольнение или отпуск ключевого админа останавливает изменения, а при аварии время восстановления зависит от того, помнит ли конкретный человек, где что лежит. Лицензии не учтены — риск штрафов при проверке.',
        actions: [
          'Собрать реестр серверов и АРМ: назначение, владелец, IP, ОС, критичность',
          'Свести реестр лицензий и договоров поддержки с фактическим использованием',
          'Зафиксировать схему сети и потоки данных между сервисами',
          'Описать процедуры: доступ, обновление, бэкап, восстановление, ротация паролей'
        ],
        implRisks: 'Инвентаризация на старте вскрывает больше, чем ожидалось (лишние серверы, «ничьи» сервисы, нелицензионный софт) и требует времени команды. Риск, что её отложат под текучку.',
        notes: 'Начать с пяти самых критичных сервисов — не пытаться описать всё сразу.',
        due: daysFromNow(30), effort: 10
      },
      {
        title: 'Интернет через один канал, резервного провайдера и второго контроллера домена нет',
        category: 'Сеть и DNS', priority: 'P2', status: 'new', owner: 'Подрядчик',
        assets: 'маршрутизатор, DC-01, VPN',
        risk: 'Отказ провайдера или маршрутизатора останавливает внешние сервисы и лишает удалённый доступ к инфраструктуре. Единственный контроллер домена — единая точка отказа для входа всех сотрудников.',
        actions: [
          'Подключить второго провайдера и настроить автоматическое переключение',
          'Поднять второй контроллер домена на отдельной площадке или хосте',
          'Проверить работу VPN и почты при переключении каналов',
          'Задокументировать сценарий аварийного переключения и проверить его на практике'
        ],
        implRisks: 'Переключение каналов может конфликтовать маршрутами и разорвать VPN. Нужно тестовое окно и доступ к оборудованию на случай ошибки.',
        notes: 'Цена вопроса — аренда второго канала; аргумент для бюджета — стоимость часа простоя.',
        due: daysFromNow(45), effort: 6
      },
      {
        title: 'Обновления учётной системы ставятся сразу на прод, без тестового контура',
        category: 'CI/CD и автоматизация', priority: 'P2', status: 'deferred', owner: 'Прикладная команда',
        assets: 'SRV-APP-01, SQL Server, учётная система',
        risk: 'Каждое обновление — лотерея: ошибки ловят пользователи в рабочее время, откатиться нечем. Простой в день закрытия периода стоит дороже самой доработки.',
        actions: [
          'Поднять тестовый контур — копию прод-среды с обезличенными данными',
          'Ввести регламент: обновление проходит тест, затем окно на проде',
          'Делать точку восстановления и продумать откат до начала работ',
          'Веcти журнал версий: что и когда установлено на проде'
        ],
        implRisks: 'Тестовый контур требует лицензий и ресурсов, а поддержка двух сред увеличивает нагрузку на команду. Есть риск, что тестовая копия разойдётся с прод-конфигурацией.',
        notes: 'Отложено: высвобождаем команду под задачи доступов и бэкапов.',
        due: daysFromNow(60), effort: 12
      },
      {
        title: 'Нет процесса управления изменениями: правки в прод без согласования',
        category: 'Люди и процессы', priority: 'P3', status: 'review', owner: 'ИТ-директор',
        assets: 'все сервисы',
        risk: 'Изменения не фиксируются, инциденты невозможно расследовать, ответственность размыта. Регулярные «внезапные» поломки без понимания, кто и что менял.',
        actions: [
          'Ввести журнал изменений (эта проблема — уже часть истории: карточка проблемы = изменение)',
          'Сделать шаблон заявки для рискованных работ: что, когда, кто, откат',
          'Согласовать окна обслуживания вне рабочего времени',
          'Пост-мортем после каждого значимого инцидента'
        ],
        implRisks: 'Бюрократия может замедлить мелкие полезные правки — сделать исключения для низкорисковых изменений, чтобы процесс не саботировали.',
        notes: 'Черновик регламента готов, жду фидбэк от команд.',
        due: daysFromNow(14), effort: 3
      },
      {
        title: 'SQL Server без резервной реплики, только полный бэкап раз в неделю',
        category: 'Базы данных', priority: 'P1', status: 'new', owner: 'Прикладная команда',
        assets: 'SRV-SQL-01',
        risk: 'Отказ единственного сервера базы останавливает учётную систему до восстановления из недельного бэкапа — потеря данных до семи дней. Плановое обслуживание возможно только с простоем.',
        actions: [
          'Настроить резервный экземпляр: Always On или log shipping',
          'Перейти на ежедневный полный бэкап и бэкап журналов транзакций каждые 15 минут',
          'Проверить восстановление на отдельном экземпляре',
          'Настроить мониторинг задержки репликации и свободного места под бэкапы'
        ],
        implRisks: 'Репликация добавляет нагрузку на диск и сеть основного сервера, ошибка в цепочке журналов рвёт восстановление. Затрагивает прод — нужна репетиция на стенде.',
        notes: 'Объём базы ≈80 ГБ; уточнить редакцию SQL Server — часть вариантов репликации доступна только в Standard/Enterprise.',
        due: daysFromNow(20), effort: 10
      }
    ];
  }

  /* ---------------------------------------------------------------- фильтры */

  function resetFilters(silent) {
    state.ui.filters = { status: [], priority: [], category: '', owner: '', overdue: false };
    state.ui.q = '';
    el.search.value = '';
    if (!silent) toast('Фильтры сброшены');
    persistAndRender();
  }

  /* ---------------------------------------------------------------- события */

  function bindEvents() {
    /* поиск */
    var searchTimer = null;
    el.search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var value = el.search.value;
      searchTimer = setTimeout(function () {
        state.ui.q = value;
        save();
        renderList();
        renderFilters();
      }, 160);
    });

    /* фильтры */
    el.statusFilters.addEventListener('click', function (event) {
      var chip = event.target.closest('[data-status]');
      if (!chip) return;
      var id = chip.getAttribute('data-status');
      var arr = state.ui.filters.status;
      var at = arr.indexOf(id);
      if (at >= 0) arr.splice(at, 1); else arr.push(id);
      persistAndRender();
    });

    el.priorityFilters.addEventListener('click', function (event) {
      var chip = event.target.closest('[data-priority]');
      if (!chip) return;
      var id = chip.getAttribute('data-priority');
      var arr = state.ui.filters.priority;
      var at = arr.indexOf(id);
      if (at >= 0) arr.splice(at, 1); else arr.push(id);
      persistAndRender();
    });

    el.catFilter.addEventListener('change', function () {
      state.ui.filters.category = el.catFilter.value;
      persistAndRender();
    });
    el.ownerFilter.addEventListener('change', function () {
      state.ui.filters.owner = el.ownerFilter.value;
      persistAndRender();
    });
    el.overdueFilter.addEventListener('change', function () {
      state.ui.filters.overdue = el.overdueFilter.checked;
      persistAndRender();
    });
    el.resetFilters.addEventListener('click', function () { resetFilters(); });

    /* вид и сортировка */
    el.viewSwitch.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-view]');
      if (!btn) return;
      state.ui.view = btn.getAttribute('data-view');
      save();
      renderList();
      renderToolbar();
    });
    el.sortSelect.addEventListener('change', function () {
      state.ui.sort = el.sortSelect.value;
      save();
      renderList();
    });

    /* таблица */
    el.tableBody.addEventListener('click', function (event) {
      var tr = event.target.closest('tr[data-id]');
      if (tr) openDrawer(tr.getAttribute('data-id'));
    });
    el.tableBody.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var tr = event.target.closest('tr[data-id]');
      if (!tr) return;
      event.preventDefault();
      openDrawer(tr.getAttribute('data-id'));
    });

    /* канбан: клик + drag&drop */
    el.board.addEventListener('click', function (event) {
      var card = event.target.closest('[data-id]');
      if (card && !card.classList.contains('is-dragging')) openDrawer(card.getAttribute('data-id'));
    });
    el.board.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var card = event.target.closest('[data-id]');
      if (!card) return;
      event.preventDefault();
      openDrawer(card.getAttribute('data-id'));
    });

    var dragId = null;
    el.board.addEventListener('dragstart', function (event) {
      if (!canWrite()) { event.preventDefault(); return; }
      var card = event.target.closest('[data-drag-id]');
      if (!card) return;
      dragId = card.getAttribute('data-drag-id');
      card.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', dragId); } catch (e) { /* ignore */ }
      }
    });
    el.board.addEventListener('dragend', function () {
      $$('.card.is-dragging', el.board).forEach(function (c) { c.classList.remove('is-dragging'); });
      dragId = null;
    });
    el.board.addEventListener('dragover', function (event) {
      var col = event.target.closest('[data-col-status]');
      if (!col || !dragId) return;
      event.preventDefault();
      $$('.col', el.board).forEach(function (c) { c.classList.remove('is-drop'); });
      col.classList.add('is-drop');
    });
    el.board.addEventListener('dragleave', function (event) {
      var col = event.target.closest('[data-col-status]');
      if (col && !col.contains(event.relatedTarget)) col.classList.remove('is-drop');
    });
    el.board.addEventListener('drop', function (event) {
      var col = event.target.closest('[data-col-status]');
      if (!col || !dragId) return;
      event.preventDefault();
      var item = findItem(dragId);
      var target = col.getAttribute('data-col-status');
      $$('.col', el.board).forEach(function (c) { c.classList.remove('is-drop'); });
      if (item && item.status !== target) {
        updateItem(item.id, { status: target, _historyText: 'Перемещено в «' + statusOf(target).label + '»' });
      }
      dragId = null;
    });

    /* пустые состояния */
    el.emptyState.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      if (action === 'new') openForm(null);
      if (action === 'demo') loadDemo();
      if (action === 'reset-filters') resetFilters();
    });

    /* карточка */
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#drawerCloseFoot').addEventListener('click', closeDrawer);
    el.drawerBackdrop.addEventListener('click', closeDrawer);
    $('#drawerEdit').addEventListener('click', function () {
      var item = findItem(state.currentId);
      if (item) openForm(item);
    });
    $('#drawerDuplicate').addEventListener('click', function () {
      if (state.currentId) duplicateItem(state.currentId);
    });
    $('#drawerDelete').addEventListener('click', function () {
      if (state.currentId) deleteItem(state.currentId);
    });

    /* форма */
    $('#newBtn').addEventListener('click', function () { openForm(null); });
    $('#modalClose').addEventListener('click', closeForm);
    $('#modalCancel').addEventListener('click', closeForm);
    el.itemForm.addEventListener('submit', submitForm);
    el.modalLayer.addEventListener('mousedown', function (event) {
      if (event.target === el.modalLayer) closeForm();
    });

    /* экспорт / импорт / печать */
    $('#exportJson').addEventListener('click', exportJson);
    $('#exportCsv').addEventListener('click', exportCsv);
    $('#importBtn').addEventListener('click', function () { $('#importFile').click(); });
    $('#importFile').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) importFile(file);
      event.target.value = '';
    });
    $('#printBtn').addEventListener('click', function () {
      if (!state.items.length) { toast('Реестр пуст — печатать нечего'); return; }
      window.print();
    });
    $('#clearBtn').addEventListener('click', clearAll);

    /* серверный режим: вход, выход, баннеры */
    if (el.loginForm) el.loginForm.addEventListener('submit', submitLogin);
    if (el.logoutBtn) el.logoutBtn.addEventListener('click', logout);
    if (el.serverBanner) {
      el.serverBanner.addEventListener('click', function (event) {
        var btn = event.target.closest('[data-banner]');
        if (!btn) return;
        var action = btn.getAttribute('data-banner');
        if (action === 'reload' || action === 'apply') { hideConflict(); serverLoad(); }
        if (action === 'force') { server.conflict = null; hideConflict(); syncNow(true); }
      });
    }

    /* тема */
    $('#themeToggle').addEventListener('click', function () {
      state.ui.theme = state.ui.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      save();
    });

    /* горячие клавиши */
    document.addEventListener('keydown', function (event) {
      var target = event.target;
      var typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      var mod = event.ctrlKey || event.metaKey;

      if (mod && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        el.search.focus();
        el.search.select();
        return;
      }
      if (event.key === 'Escape') {
        if (!el.modalLayer.hidden) { closeForm(); return; }
        if (el.drawer.classList.contains('is-open')) { closeDrawer(); return; }
      }
      if (typing || mod || event.altKey) return;
      if (event.key === 'n' || event.key === 'N' || event.key === 'т' || event.key === 'Т') {
        event.preventDefault();
        openForm(null);
      }
      if (event.key === '/' ) {
        event.preventDefault();
        el.search.focus();
      }
    });
  }

  function loadDemo() {
    if (state.items.length) {
      if (!window.confirm('В реестре уже есть записи. Добавить 10 демо-примеров к текущим?')) return;
    }
    var demo = demoItems().map(function (raw) { return normalizeItem(raw); });
    demo.forEach(function (item) {
      item.id = nextId();
      item.createdAt = isoNow();
      item.updatedAt = item.createdAt;
      item.history = [{ ts: item.createdAt, text: 'Проблема создана (демо-пример)' }];
      state.items.push(item);
    });
    persistAndRender();
    toast('Добавлено 10 демо-примеров — правьте под свою инфраструктуру', 'ok');
  }

  /* ------------------------------------------------------------------ старт */

  function init() {
    cacheEls();
    applyTheme();
    initFormSelects();
    bindEvents();

    window.addEventListener('error', function (event) {
      banner('Ошибка в ProblemBook: ' + (event.message || 'неизвестная') + '. Обновите страницу; данные не потеряны.');
      console.error(event.error || event.message);
    });

    window.addEventListener('beforeprint', updatePrintMeta);

    window.addEventListener('beforeunload', function (event) {
      if (MODE === 'server' && (server.pending || server.conflict)) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    detectMode();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
