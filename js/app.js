/* Склад: приёмка товара по 2D/QR-скану — логика интерфейса. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const num = (n) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
  const pad = (n) => String(n).padStart(2, '0');
  const timeOf = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  const dateTimeOf = (ts) => { const d = new Date(ts); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + timeOf(ts); };
  const signed = (d) => (d > 0 ? '+' : '−') + num(Math.abs(d));

  const DOUBLE_READ_MS = 400; // тот же код повторно быстрее этого — «дребезг» сканера, пропускаем
  const RECENT_LIMIT = 15;
  const LOG_LIMIT = 500;
  const HIGHLIGHT_MS = 3000;
  const KIND = {
    in: { label: 'Приход', cls: 'in' },
    out: { label: 'Расход', cls: 'out' },
    adjust: { label: 'Корректировка', cls: 'adj' },
    undo: { label: 'Отмена', cls: 'undo' },
  };
  const MODE_TEXT = { in: 'Приход', out: 'Расход', test: 'Проверка' };
  const READY_TEXT = {
    in: 'Готов. Поле очищается само после каждого скана.',
    out: 'Режим расхода: каждый скан списывает товар со склада.',
    test: 'Режим проверки: покажем, что пришло от сканера. Склад не меняется.',
  };

  const ui = {
    scanInput: $('#scan-input'), qty: $('#scan-qty'), card: $('#scan-card'), status: $('#scan-status'),
    testOut: $('#test-out'), armedText: $('#armed-text'), modeChip: $('#mode-chip'),
    recent: $('#recent'), today: $('#today'), stockCount: $('#stock-count'),
    stockQ: $('#stock-q'), stockSort: $('#stock-sort'), stockBody: $('#stock-table tbody'),
    stockEmpty: $('#stock-empty'), stockSummary: $('#stock-summary'),
    logQ: $('#log-q'), logBody: $('#log-table tbody'), logEmpty: $('#log-empty'), logNote: $('#log-note'),
    toasts: $('#toasts'), dlgEdit: $('#dlg-edit'), dlgSettings: $('#dlg-settings'),
    dlgName: $('#dlg-name'), nameInput: $('#name-input'), dlgImport: $('#dlg-import'), catalogCount: $('#catalog-count'),
  };

  const state = { tab: 'scan', mode: 'in', lastRaw: '', lastRawAt: 0, hlSku: null, hlAt: 0, editing: null, naming: null };

  /* ---------- Обработка скана ---------- */

  function parseNum(s) {
    const n = Number(String(s).replace(',', '.').replace(/\s/g, ''));
    return String(s).trim() !== '' && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
  }

  function pickQty(parsed) {
    if (parsed.qty != null) {
      const n = parseNum(parsed.qty);
      return n > 0 ? n : null;
    }
    const n = parseNum(ui.qty.value);
    return n > 0 ? n : null;
  }

  // Управляющие символы (GS и т.п.) делаем видимыми
  const visible = (s) => s.replace(/[\x00-\x1f\x7f]/g, (c) => (
    c === '\x1d' ? '⟨GS⟩' : '⟨' + c.charCodeAt(0).toString(16).padStart(2, '0') + '⟩'
  ));
  const shortCode = (s) => { const v = visible(s.trim()); return v.length > 40 ? v.slice(0, 40) + '…' : v; };

  function handleScan(raw) {
    const t = performance.now();
    if (raw === state.lastRaw && t - state.lastRawAt < DOUBLE_READ_MS) return;
    state.lastRaw = raw;
    state.lastRawAt = t;
    // Скан при открытом окне «Новый товар» — сохраняем то, что успели ввести, и идём дальше
    if (ui.dlgName.open) saveNewName();

    let parsed = null;
    let parseError = null;
    try { parsed = parseScan(raw); } catch (err) { parseError = err; console.error(err); }

    if (state.mode === 'test') { showTest(raw, parsed, parseError); return; }
    if (parsed && parsed.error) { fail(parsed.error); return; }
    if (!parsed || parsed.sku == null || String(parsed.sku).trim() === '') {
      fail('Код не распознан: ' + shortCode(raw));
      return;
    }
    const qty = pickQty(parsed);
    if (qty == null) { fail('Неверное количество — проверьте поле «Кол-во»'); return; }

    const res = Store.apply({
      sku: String(parsed.sku).trim(),
      name: parsed.name ? String(parsed.name).trim() : '',
      qty,
      mode: state.mode,
      raw,
    });
    ui.qty.value = '1';
    if (!res.ok) { fail(res.error); render(); return; }

    const p = res.product;
    const title = p.name || p.sku;
    succeed(signed(res.move.delta) + ' · ' + title + ' · остаток ' + num(p.qty) + (res.created ? ' · новый товар' : ''));
    state.hlSku = p.sku;
    state.hlAt = Date.now();
    render();
    if (res.created && !p.name && Store.settings().askName) askName(p.sku);
  }

  function showTest(raw, parsed, err) {
    const ok = !err && parsed && !parsed.error && parsed.sku != null && String(parsed.sku).trim() !== '';
    const sku = ok ? String(parsed.sku).trim() : '';
    const p = ok ? Store.product(sku) : null;
    const known = ok ? (p && p.name) || Store.catalogName(sku) : null;
    ui.testOut.textContent =
      'Пришло от сканера (' + raw.length + ' симв.):\n' + visible(raw) +
      '\n\nparseScan() вернул:\n' + (err ? 'ОШИБКА: ' + err.message : JSON.stringify(parsed, null, 2)) +
      (ok ? '\n\nНазвание: ' + (known || 'неизвестно (нет ни на складе, ни в справочнике)') +
        '\nНа складе: ' + (p ? num(p.qty) : 'нет') : '');
    if (ok) succeed('Код распознан: ' + (known || sku) + ' — склад не изменён');
    else fail(parsed && parsed.error ? parsed.error : 'Код не распознан — смотрите, что вернул parseScan()');
  }

  /* ---------- Название нового товара ---------- */

  function askName(sku) {
    state.naming = sku;
    $('#name-code').textContent = sku;
    ui.nameInput.value = '';
    ui.dlgName.showModal();
    ui.nameInput.focus();
  }

  function saveNewName() {
    const name = ui.nameInput.value.trim();
    if (name && state.naming) {
      const res = Store.rename(state.naming, name);
      if (!res.ok) toast(res.error, 'err');
    }
    state.naming = null;
    if (ui.dlgName.open) ui.dlgName.close();
    render();
  }

  function succeed(text) { feedback(text, 'ok'); }
  function fail(text) { feedback(text, 'err'); }

  function feedback(text, kind) {
    beep(kind);
    ui.status.textContent = text;
    ui.status.dataset.kind = kind;
    ui.card.classList.remove('flash-ok', 'flash-err');
    void ui.card.offsetWidth; // перезапуск анимации
    ui.card.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-err');
    if (state.tab !== 'scan') toast(text, kind);
  }

  /* ---------- Звук ---------- */

  let audio = null;
  function beep(kind) {
    if (!Store.settings().sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const tones = kind === 'ok' ? [[1250, 0, 0.09]] : [[300, 0, 0.13], [220, 0.17, 0.2]];
      tones.forEach(([freq, start, dur]) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = kind === 'ok' ? 'sine' : 'square';
        osc.frequency.value = freq;
        const t0 = audio.currentTime + start;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(kind === 'ok' ? 0.25 : 0.12, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain).connect(audio.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      });
    } catch (_) { /* звук необязателен */ }
  }

  /* ---------- Отрисовка ---------- */

  function render() {
    const products = Store.products();
    ui.stockCount.textContent = products.length;
    ui.catalogCount.textContent = num(Store.catalogSize());
    renderRecent();
    if (state.tab === 'stock') renderStock(products);
    if (state.tab === 'log') renderLog();
  }

  function moveTitle(m) {
    const p = Store.product(m.sku);
    return (p && p.name) || m.name || '';
  }

  function renderRecent() {
    const moves = Store.moves();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    let inSum = 0;
    let outSum = 0;
    moves.forEach((m) => {
      if (m.ts < start.getTime() || m.undone || (m.kind !== 'in' && m.kind !== 'out')) return;
      if (m.delta > 0) inSum += m.delta; else outSum -= m.delta;
    });
    ui.today.textContent = 'Сегодня: +' + num(inSum) + ' / −' + num(outSum);

    const last = moves.slice(-RECENT_LIMIT).reverse();
    if (!last.length) {
      ui.recent.innerHTML = '<li class="empty">Пока пусто — отсканируйте первый товар.</li>';
      return;
    }
    const named = new Set(); // кнопку «Назвать» показываем один раз на товар — в самой свежей строке
    ui.recent.innerHTML = last.map((m) => {
      const k = KIND[m.kind] || KIND.in;
      const title = moveTitle(m);
      const p = named.has(m.sku) ? null : Store.product(m.sku);
      named.add(m.sku);
      const canUndo = m.kind !== 'undo' && !m.undone;
      return '<li class="' + (m.undone ? 'is-undone' : '') + '" data-id="' + esc(m.id) + '" data-sku="' + esc(m.sku) + '">' +
        '<span class="delta ' + k.cls + '">' + signed(m.delta) + '</span>' +
        '<span class="what"><b>' + esc(title || m.sku) + '</b><small>' +
          (title ? '<span class="mono">' + esc(m.sku) + '</span> · ' : '') + k.label + (m.undone ? ' · отменено' : '') +
        '</small></span>' +
        '<span class="after" title="Остаток после операции">→ ' + num(m.after) + '</span>' +
        '<span class="time">' + timeOf(m.ts) + '</span>' +
        '<span class="acts">' +
          (p && !p.name ? '<button type="button" class="btn sm" data-act="edit">Назвать</button>' : '') +
          (canUndo ? '<button type="button" class="icon-btn sm" data-act="undo" title="Отменить операцию" aria-label="Отменить операцию"><svg class="i"><use href="#i-undo"/></svg></button>' : '') +
        '</span></li>';
    }).join('');
  }

  function renderStock(products) {
    const q = ui.stockQ.value.trim().toLowerCase();
    let list = q
      ? products.filter((p) => p.sku.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q))
      : products.slice();
    const sort = ui.stockSort.value;
    list.sort(
      sort === 'name' ? (a, b) => (a.name || a.sku).localeCompare(b.name || b.sku, 'ru')
        : sort === 'qty' ? (a, b) => b.qty - a.qty
          : (a, b) => b.updatedAt - a.updatedAt
    );
    const total = products.reduce((s, p) => s + p.qty, 0);
    ui.stockSummary.textContent = 'Позиций: ' + num(products.length) + ' · Единиц на складе: ' + num(total) +
      (q ? ' · Найдено: ' + num(list.length) : '');
    ui.stockEmpty.hidden = list.length > 0;
    ui.stockEmpty.textContent = products.length
      ? 'Ничего не найдено.'
      : 'Склад пуст. Отсканируйте первый товар — он появится здесь сам.';
    const hl = Date.now() - state.hlAt < HIGHLIGHT_MS ? state.hlSku : null;
    ui.stockBody.innerHTML = list.map((p) => (
      '<tr data-sku="' + esc(p.sku) + '" class="' + (p.sku === hl ? 'is-hl' : '') + (p.qty === 0 ? ' is-zero' : '') + '">' +
        '<td class="mono">' + esc(p.sku) + '</td>' +
        '<td>' + (p.name ? esc(p.name) : '<span class="muted">без названия</span>') + '</td>' +
        '<td class="num"><b>' + num(p.qty) + '</b></td>' +
        '<td class="muted nowrap">' + dateTimeOf(p.updatedAt) + '</td>' +
        '<td class="acts">' +
          '<button type="button" class="icon-btn sm" data-act="edit" title="Изменить" aria-label="Изменить"><svg class="i"><use href="#i-edit"/></svg></button>' +
          '<button type="button" class="icon-btn sm" data-act="del" title="Удалить" aria-label="Удалить"><svg class="i"><use href="#i-trash"/></svg></button>' +
        '</td></tr>'
    )).join('');
  }

  function renderLog() {
    const q = ui.logQ.value.trim().toLowerCase();
    let moves = Store.moves().slice().reverse();
    if (q) moves = moves.filter((m) => m.sku.toLowerCase().includes(q) || moveTitle(m).toLowerCase().includes(q));
    ui.logEmpty.hidden = moves.length > 0;
    ui.logNote.hidden = moves.length <= LOG_LIMIT;
    ui.logNote.textContent = 'Показаны последние ' + LOG_LIMIT + ' из ' + num(moves.length) + ' — полный список в CSV.';
    ui.logBody.innerHTML = moves.slice(0, LOG_LIMIT).map((m) => {
      const k = KIND[m.kind] || KIND.in;
      const canUndo = m.kind !== 'undo' && !m.undone;
      return '<tr data-id="' + esc(m.id) + '" class="' + (m.undone ? 'is-undone' : '') + '">' +
        '<td class="nowrap muted">' + dateTimeOf(m.ts) + '</td>' +
        '<td><span class="tag ' + k.cls + '">' + k.label + '</span></td>' +
        '<td class="mono">' + esc(m.sku) + '</td>' +
        '<td>' + esc(moveTitle(m)) + '</td>' +
        '<td class="num delta-txt ' + k.cls + '">' + signed(m.delta) + '</td>' +
        '<td class="num">' + num(m.after) + '</td>' +
        '<td class="acts">' + (canUndo ? '<button type="button" class="icon-btn sm" data-act="undo" title="Отменить операцию" aria-label="Отменить операцию"><svg class="i"><use href="#i-undo"/></svg></button>' : '') + '</td>' +
        '</tr>';
    }).join('');
  }

  /* ---------- Действия ---------- */

  function undoMove(id) {
    const res = Store.undo(id);
    if (res.ok) toast('Операция отменена', 'ok');
    else { toast(res.error, 'err'); beep('err'); }
    render();
  }

  function openEdit(sku) {
    const p = Store.product(sku);
    if (!p) return;
    state.editing = sku;
    $('#edit-sku').textContent = sku;
    $('#edit-name').value = p.name || '';
    $('#edit-qty').value = String(p.qty);
    ui.dlgEdit.showModal();
    $('#edit-name').focus();
  }

  function deleteProduct(sku) {
    const p = Store.product(sku);
    if (!p) return;
    const title = p.name ? '«' + p.name + '» (' + sku + ')' : sku;
    if (!confirm('Удалить товар ' + title + ' со склада? Записи в журнале останутся.')) return;
    const res = Store.remove(sku);
    toast(res.ok ? 'Товар удалён' : res.error, res.ok ? 'ok' : 'err');
    render();
  }

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    ui.toasts.appendChild(el);
    while (ui.toasts.children.length > 4) ui.toasts.firstChild.remove();
    setTimeout(() => el.classList.add('is-out'), 2600);
    setTimeout(() => el.remove(), 3000);
  }

  function stamp() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // CSV под русский Excel: разделитель «;», BOM, десятичная запятая
  function downloadCSV(filename, rows) {
    const cell = (v) => {
      let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v == null ? '' : v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // защита от формул в Excel
      return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    download(filename, '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
  }

  function exportStock() {
    const rows = [['Артикул', 'Наименование', 'Остаток', 'Обновлено']];
    Store.products()
      .sort((a, b) => (a.name || a.sku).localeCompare(b.name || b.sku, 'ru'))
      .forEach((p) => rows.push([p.sku, p.name, p.qty, new Date(p.updatedAt).toLocaleString('ru-RU')]));
    downloadCSV('sklad-ostatki-' + stamp() + '.csv', rows);
  }

  function exportLog() {
    const rows = [['Время', 'Операция', 'Артикул', 'Наименование', 'Изменение', 'Остаток после', 'Отменено', 'Код со сканера']];
    Store.moves().forEach((m) => rows.push([
      new Date(m.ts).toLocaleString('ru-RU'), (KIND[m.kind] || KIND.in).label, m.sku, moveTitle(m),
      m.delta, m.after, m.undone ? 'да' : '', m.raw ? visible(m.raw) : '',
    ]));
    downloadCSV('sklad-zhurnal-' + stamp() + '.csv', rows);
  }

  /* ---------- Вкладки, режимы, фокус ---------- */

  function setTab(tab) {
    state.tab = tab;
    $$('.tab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    ['scan', 'stock', 'log'].forEach((t) => { $('#panel-' + t).hidden = t !== tab; });
    render();
    focusScan();
  }

  function setMode(mode) {
    state.mode = mode;
    ui.card.dataset.mode = mode;
    ui.modeChip.dataset.mode = mode;
    ui.modeChip.textContent = 'Скан → ' + MODE_TEXT[mode];
    $$('.mode').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    });
    ui.testOut.hidden = mode !== 'test';
    ui.testOut.textContent = 'Отсканируйте код — здесь появится то, что прислал сканер.';
    ui.status.textContent = READY_TEXT[mode];
    ui.status.dataset.kind = '';
    focusScan();
  }

  const dialogOpen = () => !!document.querySelector('dialog[open]');

  // На вкладке «Приёмка» курсор всегда возвращается в поле скана
  function focusScan() {
    if (state.tab !== 'scan' || dialogOpen()) return;
    const a = document.activeElement;
    if (a === ui.qty || a === ui.scanInput) return;
    ui.scanInput.focus({ preventScroll: true });
  }

  function updateArmed() {
    const armed = document.activeElement === ui.scanInput;
    ui.card.classList.toggle('is-armed', armed);
    ui.armedText.textContent = armed ? 'Ожидание скана' : 'Скан примем и так — курсор не нужен';
  }

  /* ---------- Настройки и резервная копия ---------- */

  function syncSettingsForm() {
    const s = Store.settings();
    $('#set-fix').checked = !!s.fixLayout;
    $('#set-sound').checked = !!s.sound;
    $('#set-ask').checked = !!s.askName;
    $('#set-gap').value = s.maxGap;
    const n = Store.catalogSize();
    $('#set-catalog-info').textContent = n
      ? 'В справочнике ' + num(n) + ' товаров — их названия подставляются при скане.'
      : 'Справочник пуст. Загрузите таблицу «штрихкод — наименование», чтобы при скане сразу видеть название.';
  }

  /* ---------- Загрузка справочника ---------- */

  const imp = { rows: null, map: null, entries: [] };

  function openImport() {
    imp.rows = null;
    imp.entries = [];
    $('#import-file').textContent = 'Файл не выбран';
    $('#import-map').hidden = true;
    $('#import-go').disabled = true;
    $('#import-overwrite').checked = false;
    ui.dlgImport.showModal();
  }

  async function readImportFile(file) {
    $('#import-file').textContent = 'Читаю ' + file.name + '…';
    $('#import-map').hidden = true;
    $('#import-go').disabled = true;
    try {
      imp.rows = await Catalog.readFile(file);
    } catch (err) {
      console.error(err);
      $('#import-file').textContent = err.message || 'Не удалось прочитать файл';
      return;
    }
    if (!imp.rows.length) { $('#import-file').textContent = 'В файле нет данных'; return; }
    $('#import-file').textContent = file.name + ' · строк: ' + num(imp.rows.length);
    imp.map = Catalog.detect(imp.rows);
    const options = '<option value="-1">— не выбрано —</option>' + Catalog.columnLabels(imp.rows, imp.map)
      .map((label, i) => '<option value="' + i + '">' + esc(label) + '</option>').join('');
    $('#import-code').innerHTML = options;
    $('#import-name').innerHTML = options;
    $('#import-code').value = String(imp.map.codeCol);
    $('#import-name').value = String(imp.map.nameCol);
    $('#import-map').hidden = false;
    previewImport();
  }

  function previewImport() {
    imp.map.codeCol = Number($('#import-code').value);
    imp.map.nameCol = Number($('#import-name').value);
    imp.entries = Catalog.extract(imp.rows, imp.map);
    $('#import-preview tbody').innerHTML = imp.entries.slice(0, 6).map((e) => (
      '<tr><td class="mono nowrap">' + esc(e.code) + '</td><td>' + esc(e.name) + '</td></tr>'
    )).join('') || '<tr><td colspan="2" class="muted">Нет строк с кодом и названием — проверьте выбор колонок</td></tr>';
    $('#import-stats').textContent = imp.entries.length
      ? 'Будет загружено товаров: ' + num(imp.entries.length) + (imp.entries.length > 6 ? ' (выше — первые 6)' : '')
      : '';
    $('#import-go').disabled = !imp.entries.length;
  }

  function bind() {
    $$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $$('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    ui.modeChip.addEventListener('click', () => setTab('scan'));

    // Клик мимо полей ввода — возвращаем курсор в поле скана
    document.addEventListener('click', (e) => {
      if (e.target.closest('input, select, textarea, dialog')) return;
      setTimeout(focusScan, 0);
    });
    document.addEventListener('focusin', updateArmed);
    document.addEventListener('focusout', () => setTimeout(() => {
      updateArmed();
      if (document.activeElement === document.body) focusScan();
    }, 0));
    window.addEventListener('focus', () => setTimeout(focusScan, 0));
    ui.qty.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ui.scanInput.focus(); }
    });
    ui.qty.addEventListener('focus', () => ui.qty.select());

    ui.recent.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const li = btn.closest('li');
      if (btn.dataset.act === 'undo') undoMove(li.dataset.id);
      if (btn.dataset.act === 'edit') openEdit(li.dataset.sku);
    });
    ui.stockBody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const sku = btn.closest('tr').dataset.sku;
      if (btn.dataset.act === 'edit') openEdit(sku);
      if (btn.dataset.act === 'del') deleteProduct(sku);
    });
    ui.logBody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act="undo"]');
      if (btn) undoMove(btn.closest('tr').dataset.id);
    });

    ui.stockQ.addEventListener('input', () => renderStock(Store.products()));
    ui.stockSort.addEventListener('change', () => renderStock(Store.products()));
    ui.logQ.addEventListener('input', renderLog);
    $('#stock-csv').addEventListener('click', exportStock);
    $('#log-csv').addEventListener('click', exportLog);

    // Новый товар
    $('#form-name').addEventListener('submit', (e) => { e.preventDefault(); saveNewName(); });
    $('#name-later').addEventListener('click', () => { state.naming = null; ui.dlgName.close(); });

    // Справочник
    $('#stock-catalog').addEventListener('click', openImport);
    $('#import-pick').addEventListener('click', () => $('#import-input').click());
    $('#import-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) readImportFile(file);
    });
    $('#import-code').addEventListener('change', previewImport);
    $('#import-name').addEventListener('change', previewImport);
    $('#import-cancel').addEventListener('click', () => ui.dlgImport.close());
    $('#form-import').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!imp.entries.length) return;
      const res = Store.importCatalog(imp.entries, $('#import-overwrite').checked);
      if (!res.ok) { toast(res.error, 'err'); return; }
      ui.dlgImport.close();
      toast('Справочник загружен. Новых: ' + num(res.added) + ', обновлено: ' + num(res.updated) +
        (res.filled ? ', названий проставлено на складе: ' + num(res.filled) : ''), 'ok');
      render();
    });

    // Карточка товара
    $('#edit-cancel').addEventListener('click', () => ui.dlgEdit.close());
    $('#form-edit').addEventListener('submit', (e) => {
      e.preventDefault();
      const qty = parseNum($('#edit-qty').value);
      if (qty == null || qty < 0) { toast('Остаток должен быть числом от 0', 'err'); return; }
      const res = Store.update(state.editing, { name: $('#edit-name').value.trim(), qty });
      ui.dlgEdit.close();
      toast(res.ok ? 'Сохранено' : res.error, res.ok ? 'ok' : 'err');
      render();
    });

    // Настройки
    $('#btn-settings').addEventListener('click', () => { syncSettingsForm(); ui.dlgSettings.showModal(); });
    $('#form-settings').addEventListener('submit', (e) => { e.preventDefault(); ui.dlgSettings.close(); });
    $('#set-fix').addEventListener('change', (e) => Store.setSettings({ fixLayout: e.target.checked }));
    $('#set-sound').addEventListener('change', (e) => Store.setSettings({ sound: e.target.checked }));
    $('#set-ask').addEventListener('change', (e) => Store.setSettings({ askName: e.target.checked }));
    $('#set-catalog-open').addEventListener('click', () => { ui.dlgSettings.close(); openImport(); });
    $('#set-catalog-clear').addEventListener('click', () => {
      if (!Store.catalogSize() || !confirm('Очистить справочник названий? Товары на складе и их названия останутся.')) return;
      Store.clearCatalog();
      syncSettingsForm();
      render();
    });
    $('#set-gap').addEventListener('change', (e) => {
      const v = Math.min(300, Math.max(15, parseInt(e.target.value, 10) || 50));
      e.target.value = v;
      Store.setSettings({ maxGap: v });
    });
    $('#backup-save').addEventListener('click', () => download('sklad-backup-' + stamp() + '.json', Store.exportJSON(), 'application/json'));
    $('#backup-load').addEventListener('click', () => $('#backup-file').click());
    $('#backup-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch (_) { toast('Не удалось прочитать файл', 'err'); return; }
      if (!confirm('Заменить текущие товары и журнал данными из файла?')) return;
      const res = Store.importData(data);
      toast(res.ok ? 'Данные восстановлены' : res.error, res.ok ? 'ok' : 'err');
      syncSettingsForm();
      render();
    });
    $('#wipe').addEventListener('click', () => {
      if (!confirm('Удалить ВСЕ товары и весь журнал? Отменить это будет нельзя.\nСовет: сначала скачайте резервную копию.')) return;
      Store.clear();
      toast('Склад очищен', 'ok');
      render();
    });

    $$('dialog').forEach((d) => d.addEventListener('close', () => setTimeout(focusScan, 0)));

    // Склад открыт в другой вкладке браузера — подхватываем её изменения
    window.addEventListener('storage', (e) => {
      if (e.key !== Store.KEY && e.key !== Store.CATALOG_KEY) return;
      Store.reload();
      render();
    });
  }

  /* ---------- Старт ---------- */

  bind();
  setMode('in');
  setTab('scan');
  updateArmed();
  if (typeof window.parseScan !== 'function') fail('Не найдена функция parseScan() — проверьте js/parse.js');

  Scanner.attach({
    input: ui.scanInput,
    onScan: handleScan,
    settings: () => Store.settings(),
    // В окне «Новый товар» скан работает: следующий товар можно сканировать, не закрывая окно
    enabled: () => !ui.dlgEdit.open && !ui.dlgSettings.open && !ui.dlgImport.open,
  });
})();
