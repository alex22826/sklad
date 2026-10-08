/*
 * Справочник товаров из файла: чтение Excel/CSV и поиск колонок «штрихкод» и «наименование».
 * Подходит выгрузка из 1С, накладная или прайс поставщика.
 */
window.Catalog = (function () {
  'use strict';

  const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const CODE_HEAD = /штрих|barcode|ean|gtin|^шк$/i;
  // Заголовки названия — в порядке надёжности
  const NAME_HEADS = [/наимен/i, /назван/i, /номенклат/i, /товар/i, /name|описан/i];

  let xlsxPromise = null;
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    xlsxPromise = xlsxPromise || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = XLSX_URL;
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => {
        xlsxPromise = null;
        reject(new Error('Не удалось загрузить модуль Excel — нужен интернет. CSV читается и без него.'));
      };
      document.head.appendChild(s);
    });
    return xlsxPromise;
  }

  // Старые выгрузки 1С бывают в windows-1251
  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { /* не UTF-8 */ }
    return new TextDecoder('windows-1251').decode(buf);
  }

  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0];
    const delim = [';', '\t', ','].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c !== '"') cell += c;
        else if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  const cellText = (v) => (v == null ? '' : String(v).trim());

  async function readFile(file) {
    const buf = await file.arrayBuffer();
    let rows;
    if (/\.(xlsx|xlsm|xls|ods)$/i.test(file.name)) {
      const XLSX = await loadXLSX();
      const wb = XLSX.read(buf, { type: 'array' });
      // Первый лист, на котором есть данные
      rows = [];
      for (const name of wb.SheetNames) {
        rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
        if (rows.length) break;
      }
    } else {
      rows = parseCSV(decodeText(buf));
    }
    return rows.map((r) => r.map(cellText)).filter((r) => r.some((c) => c !== ''));
  }

  // Ячейка из одного или нескольких штрихкодов («4870…, 4870…»)
  const isBarcodeCell = (t) => /^[\d\s,;]+$/.test(t) && (t.match(/\d+/g) || []).some((g) => GTIN_LENGTHS.includes(g.length));

  function codesFromCell(text) {
    if (!text) return [];
    if (isBarcodeCell(text)) {
      return text.match(/\d+/g).filter((g) => GTIN_LENGTHS.includes(g.length)).map(canonicalGtin);
    }
    return [text]; // свой артикул или буквенный код
  }

  function bestColumn(width, score) {
    let best = -1;
    let bestScore = 0;
    for (let c = 0; c < width; c++) {
      const s = score(c);
      if (s > bestScore) { best = c; bestScore = s; }
    }
    return best;
  }

  // Угадываем строку заголовков и колонки; пользователь потом может поправить
  function detect(rows) {
    const width = rows.slice(0, 200).reduce((w, r) => Math.max(w, r.length), 0);
    let header = -1;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      if (rows[i].some((c) => CODE_HEAD.test(c))) { header = i; break; }
    }
    const sample = rows.slice(header + 1, header + 301);

    let codeCol = header >= 0 ? rows[header].findIndex((c) => CODE_HEAD.test(c)) : -1;
    if (codeCol < 0) codeCol = bestColumn(width, (c) => sample.filter((r) => isBarcodeCell(r[c] || '')).length);
    // Шапка без слова «штрихкод», но с «Наименование» и т.п. — тоже шапка, а не товар
    if (header < 0 && rows[0] && !isBarcodeCell(rows[0][codeCol] || '') &&
        rows[0].some((c) => NAME_HEADS.some((re) => re.test(c)))) header = 0;

    let nameCol = -1;
    if (header >= 0) {
      for (const re of NAME_HEADS) {
        nameCol = rows[header].findIndex((c, i) => i !== codeCol && re.test(c));
        if (nameCol >= 0) break;
      }
    }
    if (nameCol < 0) {
      // Колонка с самым «текстовым» содержимым
      nameCol = bestColumn(width, (c) => (c === codeCol ? 0 : sample.reduce(
        (s, r) => s + (/[A-Za-zА-Яа-яЁё]/.test(r[c] || '') ? r[c].length : 0), 0)));
    }
    return { header, codeCol, nameCol, width };
  }

  function extract(rows, map) {
    const out = [];
    const seen = new Set();
    if (map.codeCol < 0 || map.nameCol < 0) return out;
    rows.slice(map.header + 1).forEach((r) => {
      const name = (r[map.nameCol] || '').trim();
      if (!name) return;
      codesFromCell(r[map.codeCol] || '').forEach((code) => {
        if (seen.has(code)) return;
        seen.add(code);
        out.push({ code, name });
      });
    });
    return out;
  }

  // Подписи колонок для выпадающих списков: «B: Штрихкод» или «Колонка B (4870…)»
  function columnLabels(rows, map) {
    const letter = (i) => (i >= 26 ? letter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));
    const firstData = rows[map.header + 1] || [];
    return Array.from({ length: map.width }, (_, i) => {
      const head = map.header >= 0 ? rows[map.header][i] : '';
      if (head) return letter(i) + ': ' + head;
      const ex = (firstData[i] || '').slice(0, 24);
      return 'Колонка ' + letter(i) + (ex ? ' (' + ex + ')' : '');
    });
  }

  return { readFile, detect, extract, columnLabels };
})();
