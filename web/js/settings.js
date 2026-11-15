/**
 * Пользовательские настройки отображения и фонового режима.
 *
 * Храним их в localStorage (как и остальные настройки интерфейса) и дублируем
 * в нативное хранилище: там же их читает фоновая часть приложения
 * (наблюдатель на ПК, сервис на Android). Все обращения обёрнуты в try/catch:
 * localStorage может быть недоступен, но приложение должно продолжать работать.
 */

import { storageGetNative, storageSet } from "./storage.js";

const DEFAULTS = Object.freeze({
  compact: false,
  fontSize: "normal",       // normal | large | xlarge
  hideEmptyLessons: false,
  todayOnly: false,
  cacheEnabled: true,       // хранить данные для работы офлайн
  // Фоновый режим
  backgroundEnabled: true,  // проверять дневник в фоне
  notifyMarks: true,        // уведомлять о новых оценках
  notifyHomework: true,     // уведомлять о новом домашнем задании
  backgroundInterval: "10", // интервал проверки, минут
  autostart: false,         // запуск вместе с Windows (только на ПК)
});

const STORAGE_KEYS = {
  compact: "sgo.compact",
  fontSize: "sgo.fontSize",
  hideEmptyLessons: "sgo.hideEmptyLessons",
  todayOnly: "sgo.todayOnly",
  cacheEnabled: "sgo.cacheEnabled",
  backgroundEnabled: "sgo.backgroundEnabled",
  notifyMarks: "sgo.notifyMarks",
  notifyHomework: "sgo.notifyHomework",
  backgroundInterval: "sgo.backgroundInterval",
  autostart: "sgo.autostart",
};

const FONT_SIZES = ["normal", "large", "xlarge"];
const INTERVALS = ["5", "10", "15", "30", "60"];

// Настройки, которыми обмениваются с нативной частью приложения.
const NATIVE_KEYS = [
  "backgroundEnabled",
  "notifyMarks",
  "notifyHomework",
  "backgroundInterval",
  "autostart",
];

let cached = null;

function readRaw(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function writeRaw(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* localStorage недоступен */ }
}

function readBool(key, fallback = false) {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  return raw === "1";
}

function load() {
  const fontSize = readRaw(STORAGE_KEYS.fontSize);
  const interval = readRaw(STORAGE_KEYS.backgroundInterval);
  cached = {
    compact: readBool(STORAGE_KEYS.compact),
    fontSize: FONT_SIZES.includes(fontSize) ? fontSize : DEFAULTS.fontSize,
    hideEmptyLessons: readBool(STORAGE_KEYS.hideEmptyLessons),
    todayOnly: readBool(STORAGE_KEYS.todayOnly),
    // По умолчанию храним данные (включено), даже если ключа ещё нет.
    cacheEnabled: readRaw(STORAGE_KEYS.cacheEnabled) === null
      ? DEFAULTS.cacheEnabled
      : readBool(STORAGE_KEYS.cacheEnabled),
    backgroundEnabled: readBool(STORAGE_KEYS.backgroundEnabled, DEFAULTS.backgroundEnabled),
    notifyMarks: readBool(STORAGE_KEYS.notifyMarks, DEFAULTS.notifyMarks),
    notifyHomework: readBool(STORAGE_KEYS.notifyHomework, DEFAULTS.notifyHomework),
    backgroundInterval: INTERVALS.includes(interval) ? interval : DEFAULTS.backgroundInterval,
    autostart: readBool(STORAGE_KEYS.autostart, DEFAULTS.autostart),
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
  if (name === "backgroundInterval") {
    value = String(value);
    if (!INTERVALS.includes(value)) value = DEFAULTS.backgroundInterval;
  } else if (name !== "fontSize") {
    value = !!value;
  }

  s[name] = value;
  const stored = name === "fontSize" || name === "backgroundInterval"
    ? String(value)
    : (value ? "1" : "0");
  writeRaw(STORAGE_KEYS[name], stored);
  // Дублируем в нативное хранилище: его читает фоновая часть приложения.
  storageSet(STORAGE_KEYS[name], stored).catch(() => {});
  applyUiSettings();
  return s;
}

/**
 * Сверяет настройки с нативным хранилищем.
 *
 * На ПК переключатель в трее меняет настройку нативно, на Android — сервис.
 * Нативное значение здесь главное: по нему реально работает фон.
 */
export async function syncNativeSettings() {
  const s = getSettings();
  let changed = false;

  for (const name of NATIVE_KEYS) {
    const raw = await storageGetNative(STORAGE_KEYS[name]);
    if (raw === null || raw === undefined || raw === "") continue;
    const value = name === "backgroundInterval"
      ? String(raw)
      : (raw === "1" || raw === "true" || raw === true);
    if (s[name] === value) continue;
    s[name] = value;
    const stored = name === "backgroundInterval" ? value : (value ? "1" : "0");
    writeRaw(STORAGE_KEYS[name], stored);
    changed = true;
  }

  return changed;
}

/** Проставляет текущие значения настроек в элементы модального окна. */
export function applySettingsToControls() {
  const s = getSettings();
  const set = (id, value) => {
    const el = document.querySelector(id);
    if (el) el.checked = !!value;
  };

  set("#setting-compact", s.compact);
  set("#setting-hide-empty", s.hideEmptyLessons);
  set("#setting-today-only", s.todayOnly);
  set("#setting-cache", s.cacheEnabled);
  set("#setting-background", s.backgroundEnabled);
  set("#setting-notify-marks", s.notifyMarks);
  set("#setting-notify-homework", s.notifyHomework);
  set("#setting-autostart", s.autostart);

  const fontSize = document.querySelector("#setting-font-size");
  if (fontSize) fontSize.value = s.fontSize;

  const interval = document.querySelector("#setting-interval");
  if (interval) interval.value = s.backgroundInterval;
}

/**
 * Подключает чекбоксы и select из модального окна настроек.
 * onChange(name, value) вызывается после сохранения, чтобы перерисовать
 * зависящие от настроек экраны (дневник/расписание).
 */
export function bindSettingsControls(onChange) {
  applySettingsToControls();

  const compact = document.querySelector("#setting-compact");
  const hideEmpty = document.querySelector("#setting-hide-empty");
  const todayOnly = document.querySelector("#setting-today-only");
  const fontSize = document.querySelector("#setting-font-size");
  const cacheEnabled = document.querySelector("#setting-cache");
  const background = document.querySelector("#setting-background");
  const notifyMarks = document.querySelector("#setting-notify-marks");
  const notifyHomework = document.querySelector("#setting-notify-homework");
  const interval = document.querySelector("#setting-interval");
  const autostart = document.querySelector("#setting-autostart");

  if (compact) {
    compact.addEventListener("change", () => {
      setSetting("compact", compact.checked);
      if (onChange) onChange("compact", compact.checked);
    });
  }

  if (hideEmpty) {
    hideEmpty.addEventListener("change", () => {
      setSetting("hideEmptyLessons", hideEmpty.checked);
      if (onChange) onChange("hideEmptyLessons", hideEmpty.checked);
    });
  }

  if (todayOnly) {
    todayOnly.addEventListener("change", () => {
      setSetting("todayOnly", todayOnly.checked);
      if (onChange) onChange("todayOnly", todayOnly.checked);
    });
  }

  if (fontSize) {
    fontSize.addEventListener("change", () => {
      setSetting("fontSize", fontSize.value);
      if (onChange) onChange("fontSize", fontSize.value);
    });
  }

  if (cacheEnabled) {
    cacheEnabled.addEventListener("change", () => {
      setSetting("cacheEnabled", cacheEnabled.checked);
      if (onChange) onChange("cacheEnabled", cacheEnabled.checked);
    });
  }

  if (background) {
    background.addEventListener("change", () => {
      setSetting("backgroundEnabled", background.checked);
      if (onChange) onChange("backgroundEnabled", background.checked);
    });
  }

  if (notifyMarks) {
    notifyMarks.addEventListener("change", () => {
      setSetting("notifyMarks", notifyMarks.checked);
      if (onChange) onChange("notifyMarks", notifyMarks.checked);
    });
  }

  if (notifyHomework) {
    notifyHomework.addEventListener("change", () => {
      setSetting("notifyHomework", notifyHomework.checked);
      if (onChange) onChange("notifyHomework", notifyHomework.checked);
    });
  }

  if (interval) {
    interval.addEventListener("change", () => {
      setSetting("backgroundInterval", interval.value);
      if (onChange) onChange("backgroundInterval", interval.value);
    });
  }

  if (autostart) {
    autostart.addEventListener("change", () => {
      setSetting("autostart", autostart.checked);
      if (onChange) onChange("autostart", autostart.checked);
    });
  }
}
