/*
 * Приём сканов с 2D/QR-сканера.
 *
 * Сканер в режиме клавиатуры (USB/Bluetooth HID) «печатает» код очень быстро и жмёт Enter.
 * Модуль ловит это двумя путями:
 *  1. Курсор в поле скана — ждём Enter (или Tab) и забираем всё значение поля.
 *  2. Курсор где угодно ещё — копим «очередь» быстрых нажатий (паузы короче maxGap мс).
 *     Если она закончилась Enter/Tab — это скан: возвращаем полю, куда случайно
 *     напечатался код, прежнее значение и передаём код в обработчик.
 *
 * Исправление раскладки: при русской раскладке Windows сканер печатает «ФКЕ-001»
 * вместо «ART-001». Поэтому символ берём по физической клавише (event.code) из US-раскладки.
 */
window.Scanner = (function () {
  'use strict';

  const MIN_LEN = 6; // более короткие «очереди» считаем быстрым ручным набором, а не кодом

  // Физическая клавиша → [символ, символ с Shift] в US-раскладке
  const US = {
    Backquote: ['`', '~'], Minus: ['-', '_'], Equal: ['=', '+'],
    BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
    Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'],
    Space: [' ', ' '],
    NumpadDecimal: ['.', '.'], NumpadAdd: ['+', '+'], NumpadSubtract: ['-', '-'],
    NumpadMultiply: ['*', '*'], NumpadDivide: ['/', '/'],
  };
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c) => { US['Key' + c.toUpperCase()] = [c, c.toUpperCase()]; });
  ')!@#$%^&*('.split('').forEach((shifted, d) => {
    US['Digit' + d] = [String(d), shifted];
    US['Numpad' + d] = [String(d), String(d)];
  });

  let cfg = null;
  let buf = '';      // быстрые символы, набранные вне поля скана
  let lastAt = 0;    // время последнего символа
  let origin = null; // поле, куда «утёк» код, и его прежнее значение

  function charOf(e, fixLayout) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return null;
    if (!e.key || e.key.length !== 1) return null; // Shift, стрелки, «Unidentified» на телефонах
    const m = fixLayout && US[e.code];
    if (!m) return e.key;
    if (e.code.startsWith('Key')) {
      const caps = e.getModifierState ? e.getModifierState('CapsLock') : false;
      return e.shiftKey !== caps ? m[1] : m[0];
    }
    return e.shiftKey ? m[1] : m[0];
  }

  function takesText(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && /^(text|search|number|tel|url|email|password)$/.test(el.type);
  }

  function snapshot(el) {
    if (!takesText(el) && !(el && el.tagName === 'SELECT')) return null;
    let start = null;
    let end = null;
    try { start = el.selectionStart; end = el.selectionEnd; } catch (_) { /* number/select */ }
    return { el, value: el.value, start, end };
  }

  function restore() {
    if (!origin || !origin.el.isConnected || origin.el.value === origin.value) return;
    const el = origin.el;
    el.value = origin.value;
    try { if (origin.start != null) el.setSelectionRange(origin.start, origin.end); } catch (_) { /* number */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (el.tagName === 'SELECT') el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function reset() {
    buf = '';
    origin = null;
  }

  function insert(input, ch) {
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd == null ? start : input.selectionEnd;
    input.setRangeText(ch, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function submit(code, source) {
    reset();
    if (code.trim()) cfg.onScan(code, source);
  }

  function onKeydown(e) {
    if (!cfg || !cfg.enabled()) return;
    if (e.repeat) { reset(); return; } // зажатая клавиша — это не сканер

    const { fixLayout, maxGap } = cfg.settings();
    const now = performance.now();
    const gap = now - lastAt;
    const inField = document.activeElement === cfg.input;

    // Конец кода: Enter, либо Tab, пришедший «на скорости сканера»
    if (e.key === 'Enter' || e.key === 'Tab') {
      const fast = gap <= maxGap * 2;
      if (inField && (e.key === 'Enter' || (fast && cfg.input.value))) {
        e.preventDefault();
        const code = cfg.input.value;
        cfg.input.value = '';
        submit(code, 'field');
        return;
      }
      if (!inField && fast && buf.length >= MIN_LEN) {
        e.preventDefault();
        e.stopPropagation();
        const code = buf;
        restore();
        submit(code, 'global');
        return;
      }
      reset();
      return;
    }

    const ch = charOf(e, fixLayout);
    if (ch === null) return; // Shift и другие служебные клавиши поток не прерывают
    lastAt = now;

    if (inField) {
      buf = '';
      // раскладка исказила символ — печатаем правильный сами
      if (ch !== e.key) { e.preventDefault(); insert(cfg.input, ch); }
      return;
    }

    if (gap > maxGap || !buf) { buf = ''; origin = snapshot(document.activeElement); }
    buf += ch;
    // Вне текстовых полей символы всё равно никуда не попадают — гасим их,
    // чтобы пробел не «нажал» кнопку, а «/» не открыл быстрый поиск Firefox
    if (!takesText(document.activeElement) && (buf.length > 1 || ch !== ' ')) e.preventDefault();
  }

  /*
   * options.input    — поле скана
   * options.onScan   — function (code, source), source: 'field' | 'global'
   * options.settings — function () → { fixLayout, maxGap }
   * options.enabled  — function () → false, пока скан принимать не нужно (открыт диалог)
   */
  function attach(options) {
    cfg = options;
    document.addEventListener('keydown', onKeydown, true);
  }

  return { attach };
})();
