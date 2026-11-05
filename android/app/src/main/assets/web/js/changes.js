/**
 * Отслеживание новых данных между загрузками.
 *
 * Идея простая: при каждом обновлении запоминаем «отпечаток» оценок,
 * домашних заданий и расписания. В следующий раз сравниваем с ним и
 * помечаем только появившиеся элементы. Первая загрузка считается
 * базовой — иначе после установки всё выглядело бы новым.
 *
 * Данные хранятся в localStorage; при недоступном хранилище подсветка
 * просто не работает, но приложение продолжает работать.
 */

import { state } from "./state.js";

const MARK_STORE = "sgo.changes.marks.v1";
const HOMEWORK_STORE = "sgo.changes.homework.v1";
const SCHEDULE_STORE = "sgo.changes.schedule.v1";

const cache = {
  marksFingerprint: null,
  homeworkFingerprint: null,
  scheduleFingerprint: null,
  newMarks: new Set(),
  newHomework: new Set(),
  changedDays: new Set(),
};

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) { /* localStorage недоступен */ }
}

function removeKey(key) {
  try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function asDate(value) {
  return String(value || "").slice(0, 10);
}

/** Стабильный ключ оценки. id задания есть не всегда — тогда берём дату/тему. */
export function markKey(subjectName, mark) {
  const id = mark && mark.id;
  if (id !== undefined && id !== null && id !== 0 && id !== "") {
    return `id:${id}`;
  }
  return [
    "m",
    subjectName || "",
    asDate(mark && mark.date),
    mark && mark.value != null ? mark.value : "",
    (mark && mark.topic) || "",
    (mark && mark.type) || "",
  ].join("|");
}

/** Стабильный ключ домашнего задания внутри дня и урока. */
export function homeworkKey(date, lessonNumber, task) {
  const id = task && task.id;
  const stable = id !== undefined && id !== null && id !== 0 && id !== ""
    ? `id:${id}`
    : `text:${String((task && task.text) || "").trim()}`;
  return `${asDate(date)}|${lessonNumber != null ? lessonNumber : ""}|${stable}`;
}

function daySignature(day) {
  return (day && day.lessons ? day.lessons : [])
    .map((lesson) => [
      lesson.number,
      lesson.subject || "",
      lesson.start || "",
      lesson.end || "",
    ].join("~"))
    .join("|");
}

function updateGrades() {
  const data = state.grades;
  if (!data || !Array.isArray(data.subjects)) return false;

  const termKey = data.term || "current";
  const keys = [];
  for (const subject of data.subjects) {
    for (const mark of subject.marks || []) {
      keys.push(markKey(subject.name, mark));
    }
  }

  const uniqueKeys = Array.from(new Set(keys)).sort();
  const fingerprint = `${termKey}::${uniqueKeys.join("\n")}`;
  if (fingerprint === cache.marksFingerprint) return false;
  cache.marksFingerprint = fingerprint;

  const store = readJson(MARK_STORE) || {};
  const hasBaseline = hasOwn(store, termKey);
  const previous = new Set(Array.isArray(store[termKey]) ? store[termKey] : []);

  cache.newMarks = hasBaseline
    ? new Set(uniqueKeys.filter((key) => !previous.has(key)))
    : new Set();

  store[termKey] = uniqueKeys;
  writeJson(MARK_STORE, store);
  return true;
}

function updateHomework() {
  const diary = state.diary;
  if (!diary || !Array.isArray(diary.days)) return false;

  const weekKey = diary.weekStart || "current-week";
  const keys = [];
  for (const day of diary.days) {
    for (const lesson of day.lessons || []) {
      for (const task of lesson.tasks || []) {
        if (!String(task && task.text || "").trim()) continue;
        keys.push(homeworkKey(day.date, lesson.number, task));
      }
    }
  }

  const uniqueKeys = Array.from(new Set(keys)).sort();
  const fingerprint = `${weekKey}::${uniqueKeys.join("\n")}`;
  if (fingerprint === cache.homeworkFingerprint) return false;
  cache.homeworkFingerprint = fingerprint;

  const store = readJson(HOMEWORK_STORE) || {};
  const weeks = store.weeks && typeof store.weeks === "object" ? store.weeks : {};
  const hasBaseline = hasOwn(weeks, weekKey);
  const previous = new Set(Array.isArray(weeks[weekKey]) ? weeks[weekKey] : []);

  cache.newHomework = hasBaseline
    ? new Set(uniqueKeys.filter((key) => !previous.has(key)))
    : new Set();

  weeks[weekKey] = uniqueKeys;

  // Держим только последние 12 недель, чтобы хранилище не разрасталось.
  const weekNames = Object.keys(weeks);
  if (weekNames.length > 12) {
    for (const old of weekNames.slice(0, weekNames.length - 12)) delete weeks[old];
  }

  writeJson(HOMEWORK_STORE, { weeks });
  return true;
}

function updateSchedule() {
  const schedule = state.schedule;
  if (!schedule || !Array.isArray(schedule.days)) return false;

  const weekKey = schedule.weekStart || "current-week";
  const signatures = {};
  for (const day of schedule.days) {
    signatures[asDate(day.date)] = daySignature(day);
  }

  const dateKeys = Object.keys(signatures).sort();
  const fingerprint = `${weekKey}::${dateKeys.map((date) => `${date}=${signatures[date]}`).join("\n")}`;
  if (fingerprint === cache.scheduleFingerprint) return false;
  cache.scheduleFingerprint = fingerprint;

  const store = readJson(SCHEDULE_STORE) || {};
  const weeks = store.weeks && typeof store.weeks === "object" ? store.weeks : {};
  const hasBaseline = hasOwn(weeks, weekKey);
  const previous = weeks[weekKey] && typeof weeks[weekKey] === "object" ? weeks[weekKey] : {};

  cache.changedDays = hasBaseline
    ? new Set(dateKeys.filter((date) => previous[date] !== signatures[date]))
    : new Set();

  weeks[weekKey] = signatures;
  const weekNames = Object.keys(weeks);
  if (weekNames.length > 12) {
    for (const old of weekNames.slice(0, weekNames.length - 12)) delete weeks[old];
  }

  writeJson(SCHEDULE_STORE, { weeks });
  return true;
}

function setTabBadge(tabName, visible, title) {
  const tab = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (!tab) return;
  tab.classList.toggle("has-new", !!visible);
  if (visible && title) tab.title = title;
  else tab.removeAttribute("title");
}

export function updateTabBadges() {
  const marks = cache.newMarks.size;
  const homework = cache.newHomework.size;
  const schedule = cache.changedDays.size;

  setTabBadge("grades", marks > 0, `Новых оценок: ${marks}`);
  setTabBadge("diary", homework > 0, `Новых заданий: ${homework}`);
  setTabBadge("schedule", schedule > 0, "В расписании были изменения");
  setTabBadge("today", marks + homework + schedule > 0, "Есть новые данные");
}

/** Пересчитывает новые элементы по текущему состоянию state. */
export function refreshChanges() {
  let changed = false;
  changed = updateGrades() || changed;
  changed = updateHomework() || changed;
  changed = updateSchedule() || changed;
  updateTabBadges();
  return {
    changed,
    marks: cache.newMarks.size,
    homework: cache.newHomework.size,
    schedule: cache.changedDays.size,
  };
}

export function isNewMark(subjectName, mark) {
  return cache.newMarks.has(markKey(subjectName, mark));
}

export function isNewHomework(date, lessonNumber, task) {
  return cache.newHomework.has(homeworkKey(date, lessonNumber, task));
}

export function isDayChanged(date) {
  return cache.changedDays.has(asDate(date));
}

export function newMarksCount() {
  return cache.newMarks.size;
}

export function newHomeworkCount() {
  return cache.newHomework.size;
}

export function changedDaysCount() {
  return cache.changedDays.size;
}

/** Сброс при выходе из аккаунта: данные другого пользователя не должны подсвечиваться. */
export function clearChanges() {
  removeKey(MARK_STORE);
  removeKey(HOMEWORK_STORE);
  removeKey(SCHEDULE_STORE);
  cache.marksFingerprint = null;
  cache.homeworkFingerprint = null;
  cache.scheduleFingerprint = null;
  cache.newMarks = new Set();
  cache.newHomework = new Set();
  cache.changedDays = new Set();
  updateTabBadges();
}
