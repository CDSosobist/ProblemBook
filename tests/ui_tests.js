/* =========================================================================
   ProblemBook — браузерный смоук-тест (чёрный ящик через DOM).
   Подключается только в сгенерированном .selftest.html, в продакшене не нужен.
   Запуск: python3 tests/run_ui_tests.py
   ========================================================================= */
(function () {
  'use strict';

  var PHASE = window.__PB_PHASE__ || 1;
  var results = { pass: 0, fail: 0, lines: [] };

  function emit(line) {
    results.lines.push(line);
    console.log('[T] ' + line);
    if (typeof window.dump === 'function') {
      try { window.dump('[T] ' + line + '\n'); } catch (e) { /* ignore */ }
    }
  }

  function ok(name, condition, extra) {
    if (condition) { results.pass++; emit('PASS ' + name); }
    else { results.fail++; emit('FAIL ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
  }

  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function store() {
    try { return JSON.parse(localStorage.getItem('problembook.v1') || '{}'); } catch (e) { return {}; }
  }
  function items() { var s = store(); return s.items || []; }
  function rowCount() { return qa('table.pb tbody tr').length; }
  function errText() {
    var banner = q('#errBanner');
    return !banner || banner.hidden ? '' : banner.textContent;
  }
  function setVal(id, value) {
    var node = document.getElementById(id);
    if (!node) return false;
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function fireDrag(from, to) {
    var dt = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  }
  function blobSize(buttonId) {
    var captured = null;
    var origUrl = URL.createObjectURL;
    var origClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = function (blob) { captured = blob; return origUrl.call(URL, blob); };
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById(buttonId).click();
    URL.createObjectURL = origUrl;
    HTMLAnchorElement.prototype.click = origClick;
    return captured ? { size: captured.size, type: captured.type } : null;
  }

  /* ---------------------------------------------------------------- тесты */

  async function phase1() {
    emit('PHASE1 start');

    /* 1. Пустое состояние и разметка */
    ok('нет JS-ошибок при загрузке', errText() === '', errText());
    ok('заголовок страницы', document.title.indexOf('ProblemBook') >= 0, document.title);
    ok('пустой реестр: пустое состояние', rowCount() === 0 && q('#emptyState') && !q('#emptyState').hidden,
      'rows=' + rowCount());
    ok('KPI открытых = 0', q('#kpiOpen').textContent === '0', q('#kpiOpen').textContent);
    ok('7 статус-чипов', qa('#statusFilters .chip').length === 7, String(qa('#statusFilters .chip').length));
    ok('4 приоритет-чипа', qa('#priorityFilters .chip').length === 4, String(qa('#priorityFilters .chip').length));
    var gh = qa('a[href*="github.com/CDSosobist"]');
    ok('ссылка на GitHub в шапке и футере', gh.length >= 2, 'count=' + gh.length);
    ok('тема применена', !!document.documentElement.getAttribute('data-theme'));
    ok('все поля формы на месте',
      ['f-title', 'f-risk', 'f-actions', 'f-implRisks', 'f-owner', 'f-assets', 'f-due', 'f-effort', 'f-notes', 'f-priority', 'f-status', 'f-category']
        .every(function (id) { return !!document.getElementById(id); }));

    /* 2. Создание проблемы */
    q('#emptyState [data-action="new"]').click();
    await sleep(120);
    ok('форма создания открылась', !q('#modalLayer').hidden);

    setVal('f-title', 'Нет мониторинга дисков на прод-хостах');
    setVal('f-priority', 'P1');
    setVal('f-status', 'progress');
    setVal('f-category', 'Мониторинг и алертинг');
    setVal('f-risk', 'Заполнение диска замечаем по звонку пользователей.');
    setVal('f-actions', 'Поднять node_exporter\nАлерт на 85%\nДашборд в Grafana');
    setVal('f-implRisks', 'Шторм алертов в первые дни — люди перестанут их читать.');
    setVal('f-owner', 'Иван Петров');
    setVal('f-assets', 'srv-app-01, srv-app-02');
    setVal('f-due', '2026-12-01');
    setVal('f-effort', '2');
    setVal('f-notes', 'Проверить пороги на стейдже.');
    q('#itemForm').requestSubmit();
    await sleep(320);

    var first = items()[0] || {};
    ok('запись создана и получила ID PB-1', items().length === 1 && first.id === 'PB-1',
      JSON.stringify({ n: items().length, id: first.id }));
    ok('строка в таблице', rowCount() === 1, String(rowCount()));
    ok('все поля сохранены',
      first.risk.indexOf('звонку') >= 0 && first.implRisks.indexOf('Шторм') >= 0 &&
      first.notes.indexOf('стейдже') >= 0 && first.owner === 'Иван Петров' &&
      first.assets === 'srv-app-01, srv-app-02' && first.effort === 2 && first.due === '2026-12-01',
      JSON.stringify(first).slice(0, 240));
    ok('действия разобраны в массив', Array.isArray(first.actions) && first.actions.length === 3,
      JSON.stringify(first.actions));
    ok('карточка проблемы открылась', q('#drawer').classList.contains('is-open') &&
      q('#drawerTitle').textContent.indexOf('мониторинга') >= 0, q('#drawerTitle').textContent);
    ok('в карточке 3 пункта чек-листа', qa('#drawerBody .check-item').length === 3);
    ok('в карточке все блоки', ['Риск от проблемы', 'Необходимые действия', 'Риски при реализации', 'Примечания', 'Детали', 'История']
      .every(function (t) { return q('#drawerBody').textContent.indexOf(t) >= 0; }));
    ok('KPI: P1 = 1, в работе = 1', q('#kpiP1').textContent === '1' && q('#kpiInWork').textContent === '1',
      q('#kpiP1').textContent + '/' + q('#kpiInWork').textContent);
    ok('форма закрылась', q('#modalLayer').hidden);
    ok('нет ошибок после создания', errText() === '', errText());

    /* 3. Смена статуса из карточки */
    setVal('drawerStatus', 'blocked');
    await sleep(220);
    var afterStatus = items()[0];
    var hist = afterStatus.history.map(function (h) { return h.text; });
    ok('статус сменился на «Заблокирована»', afterStatus.status === 'blocked' &&
      q('table.pb tbody tr .badge-status').textContent.indexOf('Заблокирована') >= 0,
      JSON.stringify({ s: afterStatus.status }));
    ok('история без дублей о статусе', hist.filter(function (h) { return h.indexOf('Заблокирована') >= 0; }).length === 1,
      JSON.stringify(hist));
    ok('KPI «в работе» обнулился', q('#kpiInWork').textContent === '0', q('#kpiInWork').textContent);

    /* 4. Чек-лист */
    q('#drawerBody [data-check]').click();
    await sleep(200);
    ok('пункт чек-листа отмечается', JSON.stringify(items()[0].done) === '[0]' &&
      qa('#drawerBody .check-item.is-done').length === 1, JSON.stringify(items()[0].done));

    /* 5. Поиск */
    setVal('search', 'grafana');
    await sleep(420);
    ok('поиск находит по тексту действия', rowCount() === 1, String(rowCount()));
    setVal('search', 'zzz-no-such');
    await sleep(420);
    ok('пустой результат поиска', q('#tableView').hidden && !q('#emptyState').hidden &&
      q('#emptyState').textContent.indexOf('не найдено') >= 0,
      q('#emptyState').textContent.slice(0, 60));
    q('#emptyState [data-action="reset-filters"]').click();
    await sleep(320);
    ok('сброс фильтров возвращает запись', rowCount() === 1, String(rowCount()));

    /* 6. Фильтр приоритета */
    q('#priorityFilters [data-priority="P1"]').click();
    await sleep(220);
    ok('фильтр по P1', rowCount() === 1 && qa('#priorityFilters .chip.is-active').length === 1);
    q('#priorityFilters [data-priority="P1"]').click();
    await sleep(220);

    /* 7. Канбан */
    q('#viewSwitch [data-view="board"]').click();
    await sleep(260);
    ok('канбан отрисован', !q('#boardView').hidden && q('#tableView').hidden &&
      qa('#board .card').length === 1 && qa('#board .col').length >= 2,
      'cards=' + qa('#board .card').length);
    fireDrag(q('#board .card'), q('#board [data-col-status="new"]'));
    await sleep(300);
    ok('drag&drop меняет статус', items()[0].status === 'new' &&
      qa('#board [data-col-status="new"] .card').length === 1, items()[0].status);
    q('#viewSwitch [data-view="table"]').click();
    await sleep(220);

    /* 8. Тема */
    var before = document.documentElement.getAttribute('data-theme');
    q('#themeToggle').click();
    await sleep(120);
    var after = document.documentElement.getAttribute('data-theme');
    ok('тема переключается', before !== after && (after === 'light' || after === 'dark'), before + '→' + after);
    q('#themeToggle').click();
    await sleep(120);

    /* 9. Редактирование */
    q('#drawerClose').click();
    await sleep(160);
    ok('карточка закрывается', !q('#drawer').classList.contains('is-open'));

    q('table.pb tbody tr').click();
    await sleep(180);
    q('#drawerEdit').click();
    await sleep(200);
    ok('форма редактирования заполнена', !q('#modalLayer').hidden &&
      q('#f-title').value.indexOf('мониторинга') >= 0 &&
      q('#f-category').value === 'Мониторинг и алертинг',
      q('#f-title').value + ' | ' + q('#f-category').value);
    ok('отметки чек-листа переносятся в форму', q('#f-actions').value.indexOf('[x]') >= 0,
      q('#f-actions').value.slice(0, 40));

    setVal('f-title', 'Мониторинг дисков и SMART: алерты');
    setVal('f-priority', 'P2');
    q('#itemForm').requestSubmit();
    await sleep(320);
    var edited = items()[0];
    ok('изменения сохраняются', edited.title.indexOf('Мониторинг дисков и SMART') === 0 && edited.priority === 'P2',
      JSON.stringify({ t: edited.title, p: edited.priority }));
    ok('редактирование не создаёт дубликат', items().length === 1 && rowCount() === 1, String(items().length));
    var editedHistory = edited.history.map(function (h) { return h.text; });
    ok('история помнит изменение приоритета',
      editedHistory.some(function (h) { return h.indexOf('Приоритет') >= 0 || h.indexOf('отредактирована') >= 0; }),
      JSON.stringify(editedHistory));

    /* 10. Валидация */
    q('#newBtn').click();
    await sleep(160);
    setVal('f-title', '');
    q('#itemForm').requestSubmit();
    await sleep(160);
    ok('валидация пустого названия', !q('#modalLayer').hidden &&
      q('#f-title-wrap').classList.contains('invalid'));
    q('#modalCancel').click();
    await sleep(120);
    ok('отмена закрывает форму без записи', q('#modalLayer').hidden && items().length === 1);

    /* 11. Дублирование */
    q('table.pb tbody tr').click();
    await sleep(160);
    q('#drawerDuplicate').click();
    await sleep(320);
    ok('дублирование создаёт копию', items().length === 2 &&
      items().filter(function (i) { return /копия/.test(i.title); }).length === 1,
      String(items().length));

    /* 12. Удаление и отмена */
    window.confirm = function () { return true; };
    q('#drawerDelete').click();
    await sleep(320);
    ok('удаление работает', items().length === 1, String(items().length));
    ok('есть тост с «Отменить»', !!q('.toast button'));
    q('.toast button').click();
    await sleep(320);
    ok('undo восстанавливает запись', items().length === 2, String(items().length));

    /* 13. Экспорт */
    var csv = blobSize('exportCsv');
    ok('CSV формируется', !!csv && csv.size > 500, JSON.stringify(csv));
    var json = blobSize('exportJson');
    ok('JSON-экспорт формируется', !!json && json.size > 2000, JSON.stringify(json));

    /* 14. Схема хранения */
    var item = items()[0];
    ok('в записи есть все обязательные поля',
      typeof item.risk === 'string' && typeof item.implRisks === 'string' && typeof item.notes === 'string' &&
      typeof item.priority === 'string' && typeof item.status === 'string' &&
      Array.isArray(item.actions) && Array.isArray(item.history) &&
      !!item.createdAt && !!item.updatedAt,
      Object.keys(item).join(','));

    /* 15. Импорт */
    var payload = { app: 'problembook', version: 1, items: [
      { id: 'PB-77', title: 'Импортированная проблема', priority: 'P1', status: 'new',
        category: 'Бэкапы и восстановление', risk: 'риск', actions: ['раз', 'два'],
        implRisks: 'ир', notes: 'n', owner: 'Тест', due: '2026-01-01', effort: 1 }
    ] };
    var file = new File([JSON.stringify(payload)], 'pb.json', { type: 'application/json' });
    var dt = new DataTransfer();
    dt.items.add(file);
    var input = q('#importFile');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(700);
    ok('импорт JSON заменяет реестр', items().length === 1 &&
      items()[0].title === 'Импортированная проблема' && rowCount() === 1,
      JSON.stringify({ n: items().length, t: (items()[0] || {}).title }));

    ok('ошибок JS за прогон нет', errText() === '', errText());

    emit('PHASE1 pass=' + results.pass + ' fail=' + results.fail);
    try { localStorage.setItem('pb.selftest', JSON.stringify({ phase: 2 })); } catch (e) { /* ignore */ }
    location.reload();
  }


  /* ------------------------------------------------- проверки вёрстки */
  function layoutChecks(prefix) {
    var de = document.documentElement;
    ok(prefix + 'нет горизонтальной прокрутки страницы',
      de.scrollWidth <= window.innerWidth + 2,
      de.scrollWidth + ' > ' + window.innerWidth);

    var brand = q('.brand-mark');
    var brandWidth = brand ? Math.round(parseFloat(getComputedStyle(brand).width)) : 0;
    ok(prefix + 'CSS загружен (brand-mark 42px)', brandWidth === 42, String(brandWidth));

    ok(prefix + 'тема реально применена',
      getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)',
      getComputedStyle(document.body).backgroundColor);

    var main = q('.main').getBoundingClientRect();
    ok(prefix + 'основная колонка занимает место', main.width > 260, String(Math.round(main.width)));

    var side = q('.sidebar').getBoundingClientRect();
    ok(prefix + 'сайдбар отрисован', side.height > 100, String(Math.round(side.height)));

    var scrollers = qa('.table-wrap, .board-wrap, .drawer-body, .modal-layer, .search');
    var outside = qa('.app *').filter(function (node) {
      var inside = scrollers.some(function (scroller) { return scroller.contains(node); });
      if (inside) return false;
      var rect = node.getBoundingClientRect();
      return rect.width > 1 && (rect.right > window.innerWidth + 2);
    });
    ok(prefix + 'нет элементов, вылезающих за экран справа',
      outside.length === 0,
      outside.slice(0, 3).map(function (n) { return n.className || n.tagName; }).join('|'));

    var tiny = qa('.btn, .icon-btn, .chip').filter(function (node) {
      var rect = node.getBoundingClientRect();
      return rect.width > 0 && (rect.height < 24);
    });
    ok(prefix + 'кликабельные элементы не раздавлены', tiny.length === 0, 'count=' + tiny.length);

    if (window.innerWidth < 700) {
      ok(prefix + 'мобильный режим: подпись у кнопки скрыта',
        getComputedStyle(q('#newBtnLabel')).display === 'none',
        getComputedStyle(q('#newBtnLabel')).display);
    }
  }

  async function phase2() {
    var list = items();
    ok('данные переживают перезагрузку страницы', list.length === 1 &&
      list[0].title === 'Импортированная проблема', JSON.stringify({ n: list.length }));
    ok('после перезагрузки строка отрисована', rowCount() === 1, String(rowCount()));
    ok('KPI посчитан после перезагрузки', q('#kpiP1').textContent === '1', q('#kpiP1').textContent);
    ok('нет ошибок после перезагрузки', errText() === '', errText());
    layoutChecks('[' + window.innerWidth + 'px] ');

    try { localStorage.removeItem('pb.selftest'); } catch (e) { /* ignore */ }
    emit('PHASE2 pass=' + results.pass + ' fail=' + results.fail);
    if (typeof window.dump === 'function') { try { window.dump('SELFTEST_DONE\n'); } catch (e) { /* ignore */ } }
    console.log('SELFTEST_DONE');
  }

  async function main() {
    try {
      if (PHASE === 2) { await phase2(); } else { await phase1(); }
    } catch (error) {
      emit('FAIL fatal :: ' + (error && error.stack ? error.stack : error));
      if (typeof window.dump === 'function') { try { window.dump('SELFTEST_DONE\n'); } catch (e) { /* ignore */ } }
      console.log('SELFTEST_DONE');
    }
  }

  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(main, 400);
  });
})();
