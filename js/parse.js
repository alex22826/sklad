/*
 * Разбор содержимого кода со сканера.
 *
 * Вход:  raw — строка, которую «напечатал» сканер (уже без завершающего Enter).
 * Выход: { sku, name, qty } — код товара, название (если зашито в код) и количество за скан;
 *        { error } — код считан, но с ошибкой (например, не сходится контрольная цифра);
 *        null — пусто.
 *
 * Поддерживается:
 *  - штрихкоды производителей EAN-8 / UPC-A / EAN-13 / GTIN-14 — с проверкой контрольной цифры;
 *  - любые свои коды (артикулы, QR) — берутся как есть.
 *
 * Что именно присылает сканер и что вернула эта функция, видно в режиме «Проверка».
 */
const GTIN_LENGTHS = [8, 12, 13, 14];

// Контрольная цифра GTIN: веса 3 и 1 по очереди справа налево (без самой контрольной цифры)
function gtinValid(digits) {
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

// Единый вид штрихкода: UPC-A (12 цифр) и GTIN-14 с ведущим нулём — это тот же EAN-13
function canonicalGtin(digits) {
  if (digits.length === 12) return '0' + digits;
  if (digits.length === 14 && digits[0] === '0') return digits.slice(1);
  return digits;
}

function parseScan(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;

  // Штрихкод из цифр. До двух случайных символов по краям («'», пробел) отбрасываем —
  // так при русской раскладке выглядит случайно нажатая «Э».
  const m = text.match(/^[^A-Za-z0-9]{0,2}(\d+)[^A-Za-z0-9]{0,2}$/);
  if (m && GTIN_LENGTHS.includes(m[1].length)) {
    if (!gtinValid(m[1])) return { error: 'Штрихкод считан с ошибкой (не сходится контрольная цифра): ' + m[1] };
    return { sku: canonicalGtin(m[1]), name: null, qty: null };
  }

  // Свой код — артикул или QR — как есть
  return { sku: text, name: null, qty: null };
}
