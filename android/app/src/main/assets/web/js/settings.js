/**
 * Пользовательские настройки отображения.
 *
 * Храним их в localStorage (как и остальные настройки интерфейса).
 * Все обращения обёрнуты в try/catch: в приватном режиме localStorage
 * может быть недоступен, но приложение должно продолжать работать.
 */

const DEFAULTS = Object.freeze({
  compact: false,
  fontSize: "normal",       // normal | large | xlarge
  hideEmptyLessons: false,
  todayOnly: false,
});

const STORAGE_KEYS = {
  compact: "sgo.compact",
  fontSize: "sgo.fontSize",
  hideEmptyLessons: "sgo.hideEmptyLessons",
  todayOnly: "sgo.todayOnly",
};

const FONT_SIZES = ["normal", "large", "xlarge"];

let cached = null;

function readRaw(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function writeRaw(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* localStorage недоступен */ }
}

function readBool(key) {
  return readRaw(key) === "1";
}

function load() {
  const fontSize = readRaw(STORAGE_KEYS.fontSize);
  cached = {
    compact: readBool(STORAGE_KEYS.compact),
    fontSize: FONT_SIZES.includes(fontSize) ? fontSize : DEFAULTS.fontSize,
    hideEmptyLessons: readBool(STORAGE_KEYS.hideEmptyLessons),
    todayOnly: readBool(STORAGE_KEYS.todayOnly),
  };
  return cached;
}

export function getSettings() {
  return cached || load();
}

/** Применяет настройки к <body>. Вызывается при старте и после изменений. */
export function applyUiSettings() {
  const s = getSettings();
  const body = document.body;
  if (!body) return s;

  body.classList.toggle("is-compact", !!s.compact);
  body.classList.toggle("font-large", s.fontSize === "large");
  body.classList.toggle("font-xlarge", s.fontSize === "xlarge");
  return s;
}

export function setSetting(name, value) {
  const s = getSettings();
  if (!(name in DEFAULTS)) return s;

  if (name === "fontSize" && !FONT_SIZES.includes(value)) value = DEFAULTS.fontSize;
  if (name !== "fontSize") value = !!value;

  s[name] = value;
  writeRaw(STORAGE_KEYS[name], name === "fontSize" ? value : (value ? "1" : "0"));
  applyUiSettings();
  return s;
}

/**
 * Подключает чекбоксы и select из модального окна настроек.
 * onChange(name, value) вызывается после сохранения, чтобы перерисовать
 * зависящие от настроек экраны (дневник/расписание).
 */
export function bindSettingsControls(onChange) {
  const compact = document.querySelector("#setting-compact");
  const hideEmpty = document.querySelector("#setting-hide-empty");
  const todayOnly = document.querySelector("#setting-today-only");
  const fontSize = document.querySelector("#setting-font-size");
  const s = getSettings();

  if (compact) {
    compact.checked = s.compact;
    compact.addEventListener("change", () => {
      setSetting("compact", compact.checked);
      if (onChange) onChange("compact", compact.checked);
    });
  }

  if (hideEmpty) {
    hideEmpty.checked = s.hideEmptyLessons;
    hideEmpty.addEventListener("change", () => {
      setSetting("hideEmptyLessons", hideEmpty.checked);
      if (onChange) onChange("hideEmptyLessons", hideEmpty.checked);
    });
  }

  if (todayOnly) {
    todayOnly.checked = s.todayOnly;
    todayOnly.addEventListener("change", () => {
      setSetting("todayOnly", todayOnly.checked);
      if (onChange) onChange("todayOnly", todayOnly.checked);
    });
  }

  if (fontSize) {
    fontSize.value = s.fontSize;
    fontSize.addEventListener("change", () => {
      setSetting("fontSize", fontSize.value);
      if (onChange) onChange("fontSize", fontSize.value);
    });
  }
}
