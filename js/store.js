/*
 * Данные склада: товары, журнал движений, настройки и справочник названий.
 * Хранятся в localStorage этого браузера.
 *
 * Журнал устроен как учётная книга: отмена не удаляет запись, а помечает её
 * и добавляет обратную операцию — поэтому «остаток после» в журнале всегда сходится.
 *
 * Справочник (код → название) лежит под отдельным ключом: он бывает большим,
 * и его незачем перезаписывать на каждом скане.
 */
window.Store = (function () {
  'use strict';

  const KEY = 'sklad.v1';
  const CATALOG_KEY = 'sklad.catalog.v1';
  const MAX_MOVES = 5000; // журнал ограничен по длине, на остатки это не влияет
  const DEFAULTS = { fixLayout: true, sound: true, maxGap: 50, askName: true };

  const round = (n) => Math.round(n * 1000) / 1000;
  const fmt = (n) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  let db = load();
  let catalog = loadCatalog();

  function blank(settings) {
    return { products: {}, moves: [], settings: Object.assign({}, DEFAULTS, settings) };
  }

  function normalize(d) {
    if (!d || typeof d.products !== 'object' || d.products === null || !Array.isArray(d.moves)) return null;
    return { products: d.products, moves: d.moves, settings: Object.assign({}, DEFAULTS, d.settings) };
  }

  function load() {
    try {
      return normalize(JSON.parse(localStorage.getItem(KEY))) || blank();
    } catch (e) {
      console.warn('Склад: сохранённые данные не прочитались', e);
      return blank();
    }
  }

  function loadCatalog() {
    try {
      const c = JSON.parse(localStorage.getItem(CATALOG_KEY));
      return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
    } catch (_) {
      return {};
    }
  }

  // Сохраняем; если память браузера переполнена — откатываемся к последнему сохранённому состоянию
  function commit(result) {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
      return result;
    } catch (e) {
      console.error(e);
      db = load();
      return { ok: false, error: 'Не удалось сохранить: память браузера заполнена' };
    }
  }

  function saveCatalog() {
    try {
      localStorage.setItem(CATALOG_KEY, JSON.stringify(catalog));
      return true;
    } catch (e) {
      console.error(e);
      catalog = loadCatalog();
      return false;
    }
  }

  // Название, заданное вручную, запоминаем в справочнике — оно переживёт и удаление товара
  function remember(sku, name) {
    if (name && catalog[sku] !== name) {
      catalog[sku] = name;
      saveCatalog();
    }
  }

  function addMove(m) {
    m.id = uid();
    m.ts = Date.now();
    db.moves.push(m);
    if (db.moves.length > MAX_MOVES) db.moves.splice(0, db.moves.length - MAX_MOVES);
    return m;
  }

  // Приход (mode 'in') или расход (mode 'out') по одному скану
  function apply({ sku, name, qty, mode, raw }) {
    let p = db.products[sku];
    const created = !p;
    const known = name || catalog[sku] || '';
    if (created) {
      if (mode === 'out') return { ok: false, error: 'Товара «' + (known || sku) + '» нет на складе' };
      p = { sku, name: known, qty: 0, createdAt: Date.now(), updatedAt: Date.now() };
    } else if (known && !p.name) {
      p.name = known;
    }
    const delta = mode === 'out' ? -qty : qty;
    if (p.qty + delta < 0) {
      return { ok: false, error: 'Не хватает: на складе ' + fmt(p.qty) + ', списываем ' + fmt(qty) };
    }
    db.products[sku] = p;
    p.qty = round(p.qty + delta);
    p.updatedAt = Date.now();
    const move = addMove({ kind: mode, sku, name: p.name, delta, after: p.qty, raw: raw || '', created });
    return commit({ ok: true, product: p, move, created });
  }

  function undo(id) {
    const m = db.moves.find((x) => x.id === id);
    if (!m) return { ok: false, error: 'Операция не найдена' };
    if (m.undone || m.kind === 'undo') return { ok: false, error: 'Эту операцию отменить нельзя' };
    const p = db.products[m.sku];
    if (!p) return { ok: false, error: 'Товар уже удалён со склада' };
    if (p.qty - m.delta < 0) return { ok: false, error: 'Нельзя отменить: остаток уйдёт в минус' };
    p.qty = round(p.qty - m.delta);
    p.updatedAt = Date.now();
    m.undone = true;
    addMove({ kind: 'undo', sku: m.sku, name: p.name, delta: -m.delta, after: p.qty, ref: m.id });
    // Товар, появившийся из-за ошибочного скана, убираем целиком
    const otherActivity = db.moves.some((x) => x.sku === m.sku && x !== m && !x.undone && x.kind !== 'undo');
    if (m.created && p.qty === 0 && !otherActivity) delete db.products[m.sku];
    return commit({ ok: true, product: p, move: m });
  }

  function rename(sku, name) {
    const p = db.products[sku];
    if (!p) return { ok: false, error: 'Товар не найден' };
    p.name = name;
    p.updatedAt = Date.now();
    remember(sku, name);
    return commit({ ok: true, product: p });
  }

  // Правка карточки: название и (при необходимости) корректировка остатка
  function update(sku, { name, qty }) {
    const p = db.products[sku];
    if (!p) return { ok: false, error: 'Товар не найден' };
    p.name = name;
    remember(sku, name);
    const delta = round(qty - p.qty);
    if (delta) {
      p.qty = round(qty);
      addMove({ kind: 'adjust', sku, name: p.name, delta, after: p.qty });
    }
    p.updatedAt = Date.now();
    return commit({ ok: true, product: p });
  }

  function remove(sku) {
    if (!db.products[sku]) return { ok: false, error: 'Товар не найден' };
    delete db.products[sku];
    return commit({ ok: true });
  }

  /*
   * Загрузка справочника: entries = [{ code, name }].
   * Новые строки добавляются, совпавшие коды получают название из файла.
   * Товарам на складе без названия оно проставляется; с названием — только при overwrite.
   */
  function importCatalog(entries, overwrite) {
    let added = 0;
    let updated = 0;
    entries.forEach(({ code, name }) => {
      if (!(code in catalog)) added++;
      else if (catalog[code] !== name) updated++;
      catalog[code] = name;
    });
    if (!saveCatalog()) return { ok: false, error: 'Справочник не поместился в память браузера' };
    let filled = 0;
    Object.values(db.products).forEach((p) => {
      const n = catalog[p.sku];
      if (n && p.name !== n && (overwrite || !p.name)) {
        p.name = n;
        filled++;
      }
    });
    return commit({ ok: true, added, updated, filled });
  }

  function clearCatalog() {
    catalog = {};
    saveCatalog();
    return { ok: true };
  }

  function setSettings(patch) {
    Object.assign(db.settings, patch);
    return commit({ ok: true });
  }

  function exportJSON() {
    return JSON.stringify({ app: 'sklad', version: 1, exportedAt: new Date().toISOString(), ...db, catalog }, null, 2);
  }

  function importData(obj) {
    const d = normalize(obj);
    if (!d) return { ok: false, error: 'Файл не похож на резервную копию склада' };
    db = d;
    if (obj.catalog && typeof obj.catalog === 'object') {
      catalog = obj.catalog;
      saveCatalog();
    }
    return commit({ ok: true });
  }

  function clear() {
    db = blank(db.settings);
    return commit({ ok: true });
  }

  return {
    KEY,
    CATALOG_KEY,
    products: () => Object.values(db.products),
    product: (sku) => db.products[sku] || null,
    moves: () => db.moves,
    settings: () => db.settings,
    catalogName: (code) => catalog[code] || null,
    catalogSize: () => Object.keys(catalog).length,
    apply, undo, rename, update, remove, importCatalog, clearCatalog,
    setSettings, exportJSON, importData, clear,
    reload: () => { db = load(); catalog = loadCatalog(); },
  };
})();
