/**
 * Модули главного экрана и настройка их раскладки.
 *
 * Главный экран собирается из независимых модулей (расписание, домашнее
 * задание, оценки, заметки, изображение…). Пользователь может скрыть
 * ненужные модули и поменять их порядок перетаскиванием.
 *
 * Раскладка хранится в localStorage (и дублируется в нативное хранилище,
 * чтобы переживать смену порта и приватный режим).
 */

import { storageGet, storageSet } from "./storage.js";

/** Реестр модулей: id → название. Порядок здесь — умолчательный. */
export const HOME_MODULES = Object.freeze([
  { id: "schedule", title: "Расписание", hint: "Что сейчас и что дальше" },
  { id: "tomorrow", title: "Расписание на завтра", hint: "Уроки следующего дня" },
  { id: "homework", title: "Домашнее задание", hint: "Задания на сегодня и завтра" },
  { id: "grades", title: "Последние оценки", hint: "Недавние отметки по предметам" },
  { id: "summary", title: "Сводка", hint: "Средний балл, оценки и долги" },
  { id: "attention", title: "Требует внимания", hint: "Долги и предметы в зоне риска" },
  { id: "notes", title: "Заметки", hint: "Ваша собственная запись" },
  { id: "image", title: "Изображение", hint: "Своя картинка на главном экране" },
]);

const MODULE_IDS = HOME_MODULES.map((item) => item.id);
const STORAGE_KEY = "sgo.home.layout";

export const MIN_SPAN = 1;
export const MAX_SPAN = 3;

/** Высота модуля: сколько пикселей занимает карточка. 0 — по содержимому. */
export const MIN_HEIGHT = 120;
export const MAX_HEIGHT = 1600;

const DEFAULT_LAYOUT = Object.freeze({
  order: MODULE_IDS.slice(),
  hidden: [],
  wide: [],
  spans: {},
  heights: {},
  columns: 1,
});

function readRaw() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
}

function writeRaw(value) {
  try { localStorage.setItem(STORAGE_KEY, value); } catch (_) { /* ignore */ }
}

function sanitize(raw) {
  const layout = {
    order: [],
    hidden: [],
    wide: [],
    spans: {},
    heights: {},
    columns: 1,
  };
  if (raw && typeof raw === "object" && raw !== null) {
    if (Array.isArray(raw.order)) layout.order = raw.order.filter((id) => MODULE_IDS.includes(id));
    if (Array.isArray(raw.hidden)) layout.hidden = raw.hidden.filter((id) => MODULE_IDS.includes(id));
    if (Array.isArray(raw.wide)) layout.wide = raw.wide.filter((id) => MODULE_IDS.includes(id));
    if (raw.spans && typeof raw.spans === "object") {
      for (const id of MODULE_IDS) {
        const span = Number(raw.spans[id]);
        if (Number.isFinite(span)) layout.spans[id] = clampSpan(span);
      }
    }
    if (raw.heights && typeof raw.heights === "object") {
      for (const id of MODULE_IDS) {
        const height = clampHeight(raw.heights[id]);
        if (height) layout.heights[id] = height;
      }
    }
    if (raw.columns != null) layout.columns = clampSpan(raw.columns);
  }
  // Модули, о которых не знаем (добавлены в новой версии), ставим в конец.
  for (const id of MODULE_IDS) {
    if (!layout.order.includes(id)) layout.order.push(id);
  }
  // Прежний формат: «широкий» модуль = две колонки.
  for (const id of layout.wide) {
    if (!layout.spans[id]) layout.spans[id] = 2;
  }
  // Первый модуль всегда виден — иначе экран окажется пустым.
  if (layout.order.length && layout.hidden.includes(layout.order[0])) {
    layout.hidden = layout.hidden.filter((id) => id !== layout.order[0]);
  }
  return layout;
}

/** Ширина модуля в колонках: от 1 до 3. */
function clampSpan(value) {
  const span = Math.round(Number(value) || 1);
  if (span < MIN_SPAN) return MIN_SPAN;
  if (span > MAX_SPAN) return MAX_SPAN;
  return span;
}

/** Высота модуля в пикселях. 0 — карточка по содержимому. */
function clampHeight(value) {
  const height = Math.round(Number(value) || 0);
  if (!height) return 0;
  if (height < MIN_HEIGHT) return MIN_HEIGHT;
  if (height > MAX_HEIGHT) return MAX_HEIGHT;
  return height;
}

/** Текущая раскладка главного экрана. */
export function getHomeLayout() {
  const raw = readRaw();
  if (!raw) {
    return {
      ...DEFAULT_LAYOUT,
      order: DEFAULT_LAYOUT.order.slice(),
      hidden: [],
      wide: [],
      spans: {},
      heights: {},
    };
  }
  try {
    return sanitize(JSON.parse(raw));
  } catch (_) {
    return {
      ...DEFAULT_LAYOUT,
      order: DEFAULT_LAYOUT.order.slice(),
      hidden: [],
      wide: [],
      spans: {},
      heights: {},
    };
  }
}

/** Сохраняет раскладку (в localStorage и в нативном хранилище). */
export function saveHomeLayout(layout) {
  const clean = sanitize(layout);
  writeRaw(JSON.stringify(clean));
  storageSet(STORAGE_KEY, JSON.stringify(clean)).catch(() => {});
  return clean;
}

/** Видимые модули в заданном порядке. */
export function visibleModules(layout = getHomeLayout()) {
  return layout.order.filter((id) => !layout.hidden.includes(id));
}

export function isModuleVisible(id, layout = getHomeLayout()) {
  return !layout.hidden.includes(id);
}

/** Показывает или прячет модуль. */
export function setModuleVisible(id, visible) {
  const layout = getHomeLayout();
  if (visible) {
    layout.hidden = layout.hidden.filter((item) => item !== id);
  } else if (!layout.hidden.includes(id)) {
    layout.hidden.push(id);
    // Хотя бы один модуль должен остаться.
    const order = layout.order.filter((item) => !layout.hidden.includes(item));
    if (!order.length) layout.hidden = layout.hidden.filter((item) => item !== id);
  }
  return saveHomeLayout(layout);
}

/** Перемещает модуль на одну позицию вверх (-1) или вниз (+1). */
export function moveModule(id, delta) {
  const layout = getHomeLayout();
  const index = layout.order.indexOf(id);
  if (index < 0) return layout;
  const target = index + (delta < 0 ? -1 : 1);
  if (target < 0 || target >= layout.order.length) return layout;
  const order = layout.order.slice();
  order.splice(index, 1);
  order.splice(target, 0, id);
  layout.order = order;
  return saveHomeLayout(layout);
}

/** Ставит модуль в указанную позицию (перетаскивание). */
export function setModuleOrder(order) {
  const layout = getHomeLayout();
  const clean = Array.isArray(order) ? order.filter((id) => MODULE_IDS.includes(id)) : [];
  for (const id of MODULE_IDS) {
    if (!clean.includes(id)) clean.push(id);
  }
  layout.order = clean;
  return saveHomeLayout(layout);
}

/** Растянуть модуль на две колонки или вернуть в одну. */
export function setModuleWide(id, wide) {
  const layout = getHomeLayout();
  if (wide) {
    if (!layout.wide.includes(id)) layout.wide.push(id);
    layout.spans[id] = 2;
  } else {
    layout.wide = layout.wide.filter((item) => item !== id);
    layout.spans[id] = 1;
  }
  return saveHomeLayout(layout);
}

export function isModuleWide(id, layout = getHomeLayout()) {
  return layout.wide.includes(id);
}

/** Ширина модуля в колонках (1–3). */
export function getModuleSpan(id, layout = getHomeLayout()) {
  const span = clampSpan((layout.spans && layout.spans[id]) || 1);
  return span;
}

/** Задаёт ширину модуля в колонках (1–3). */
export function setModuleSpan(id, span) {
  const layout = getHomeLayout();
  layout.spans[id] = clampSpan(span);
  layout.wide = layout.spans[id] > 1
    ? Array.from(new Set([...layout.wide.filter((item) => item !== id), id]))
    : layout.wide.filter((item) => item !== id);
  return saveHomeLayout(layout);
}

/** Сколько колонок в сетке главного экрана (1–3). */
export function getGridColumns(layout = getHomeLayout()) {
  return clampSpan(layout.columns || 1);
}
/** Задаёт число колонок в сетке главного экрана (1–3). */
export function setGridColumns(columns) {
  const layout = getHomeLayout();
  layout.columns = clampSpan(columns);
  return saveHomeLayout(layout);
}

/** Заданная высота модуля в пикселях (0 — по содержимому). */
export function getModuleHeight(id, layout = getHomeLayout()) {
  const heights = layout.heights || {};
  return clampHeight(heights[id]);
}

/** Задаёт высоту модуля в пикселях (0 — вернуть по содержимому). */
export function setModuleHeight(id, height) {
  const layout = getHomeLayout();
  const value = clampHeight(height);
  if (!value) delete layout.heights[id];
  else layout.heights[id] = value;
  return saveHomeLayout(layout);
}

/** Убирает заданные высоты у всех модулей. */
export function clearModuleHeights() {
  const layout = getHomeLayout();
  layout.heights = {};
  return saveHomeLayout(layout);
}

/** Название модуля по id. */
export function moduleTitle(id) {
  const found = HOME_MODULES.find((item) => item.id === id);
  return found ? found.title : id;
}
