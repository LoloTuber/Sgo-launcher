/**
 * Сообщения об ошибках для пользователя.
 *
 * Обычному пользователю не нужны технические детали: пути к файлам, имена
 * исключений, подсказки разработчика. Поэтому в обычном режиме показываем
 * короткое понятное сообщение, а в служебном режиме — текст как есть.
 */

import { isDeveloperMode } from "./settings.js";

// Технический хвост вида «(ConnectionError: ...)» в конце сообщения.
const TECHNICAL_TAIL = /\s*\([^()]*(?:Error|Exception|Traceback|HTTP\s*\d|status\s*\d|line\s+\d+)[^()]*\)\s*$/i;

const GENERIC = "Что-то пошло не так. Попробуйте обновить данные.";

/**
 * Текст ошибки, который уместно показать человеку.
 *
 * @param {string} text — исходный текст ошибки (от сервера или сети)
 */
export function userError(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return GENERIC;
  if (isDeveloperMode()) return raw;

  let clean = raw;

  // Ошибки поиска школы — объясняем по-человечески.
  if (/Найдено несколько подходящих школ/i.test(clean)) {
    return "Подходит несколько школ — уточните название школы.";
  }
  if (/Школа «.*» не найдена/i.test(clean)) {
    return "Школа не найдена. Проверьте название или укажите ID школы.";
  }
  if (/Нужно указать школу/i.test(clean)) {
    return "Укажите школу — введите её название или ID.";
  }

  // Убираем технический хвост и упоминания служебных файлов.
  clean = clean.replace(TECHNICAL_TAIL, "");
  clean = clean.replace(/sgo_config\.json/gi, "файл настроек");
  clean = clean.replace(/\s*--school-id[^\n]*/gi, "");
  clean = clean.replace(/\n{2,}/g, "\n").trim();

  return clean || GENERIC;
}

/**
 * Технические подробности ошибки — только для служебного режима.
 * В обычном режиме возвращает пустую строку.
 */
export function errorDetails(text) {
  if (!isDeveloperMode()) return "";
  const raw = String(text == null ? "" : text).trim();
  return raw ? raw : "";
}
