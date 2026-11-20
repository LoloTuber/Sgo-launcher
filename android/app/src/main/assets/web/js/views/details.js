/**
 * Подробности задания и оценки.
 *
 * Один общий модуль для дневника и «Успеваемости»: обе вкладки показывают
 * одинаковый набор сведений (тема, предмет, дата, вес, учитель, средний балл
 * класса, оценки класса, комментарий, файлы).
 *
 * Здесь же — локальный кэш подробностей, чтобы повторный клик не ходил в сеть.
 */

import { escapeHtml, markCls, formatAverage } from '../utils.js';
import { storageGet, storageSet } from '../storage.js';
import * as api from '../api.js';

// Префикс совпадает с общим кэшем приложения (sgo.cache.*) — очистка кэша
// при выходе из аккаунта затрагивает и подробности.
const CACHE_PREFIX = "sgo.cache.details.";

// Локальный кэш считаем свежим 6 часов: оценки учителя меняются редко,
// а сеть в дневнике может быть недоступна.
const LOCAL_TTL_MS = 6 * 60 * 60 * 1000;

// Кэш в памяти вкладки — на него попадает всё, что уже загрузили.
const memory = new Map();

/** «2026-11-12» → «12.11.2026». */
export function formatDateFull(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!match) return "";
  return `${match[3]}.${match[2]}.${match[1]}`;
}

/**
 * Рендер подробностей по заданию (оценке или домашнему заданию).
 *
 * @param {object} data      — ответ сервера (/api/assignment/{id})
 * @param {string} markValue — оценка, если открываем по отметке
 * @param {boolean} skipTopic — тема совпадает с текстом задания, не дублируем
 */
export function renderAssignmentDetails(data, markValue, skipTopic) {
  const rows = [];
  const add = (label, html) => {
    if (html) rows.push(`<div class="dl-row"><span class="label">${label}</span><span class="value">${html}</span></div>`);
  };

  data = data || {};

  if (markValue) {
    add("Оценка", `<span class="mark-value ${markCls(markValue)}">${escapeHtml(markValue)}</span>`);
  }
  add("Тема", skipTopic ? "" : escapeHtml(data.topic || ""));
  add("Предмет", escapeHtml(data.subject || ""));
  add("Дата", data.date ? escapeHtml(formatDateFull(data.date)) : "");
  if (Number(data.weight) > 0) add("Вес", `×${escapeHtml(String(data.weight))}`);

  if (data.teachers && data.teachers.length) {
    add("Учитель", escapeHtml(data.teachers.join(", ")));
  }

  if (data.averageMark !== null && data.averageMark !== undefined && data.averageMark !== "") {
    add("Средний балл класса", escapeHtml(formatAverage(data.averageMark)));
  }

  if (data.markStats && data.markStats.length) {
    const chips = data.markStats.map((stat) => `
      <span class="dl-class-mark">
        <span class="mark-value ${markCls(stat.mark)}">${escapeHtml(String(stat.mark))}</span>
        <span class="dl-class-mark-text">${escapeHtml(String(stat.count))} чел. · ${escapeHtml(String(stat.percentage))}%</span>
      </span>`).join("");
    rows.push(
      `<div class="dl-row dl-row-wide">
         <span class="label">Оценки класса</span>
         <div class="dl-class-marks">${chips}</div>
       </div>`
    );
  }

  (data.details || []).forEach((text) => {
    rows.push(
      `<div class="dl-row dl-row-wide">
         <span class="label">Комментарий</span>
         <span class="value">${escapeHtml(text)}</span>
       </div>`
    );
  });

  if (data.files && data.files.length) {
    rows.push(
      `<div class="dl-row dl-row-wide">
         <span class="label">Файлы</span>
         <div class="files">${data.files
           .map((file) => `<span class="file">📎 ${escapeHtml(file)}</span>`)
           .join("")}</div>
       </div>`
    );
  }

  if (!rows.length) {
    return `<p class="meta">Дополнительных сведений нет.</p>`;
  }

  return `<div class="dl-details">${rows.join("")}</div>`;
}

/**
 * Загружает подробности задания: сначала кэш, потом сеть.
 * Ошибки пробрасываются наверх — вызывающий покажет их пользователю.
 */
export async function loadDetails(id) {
  const key = String(id);
  if (!key) throw new Error("Нет идентификатора задания");
  if (memory.has(key)) return memory.get(key);

  const cached = await readLocalCache(key);
  if (cached) {
    memory.set(key, cached);
    return cached;
  }

  const data = await api.getAssignmentDetails(id);
  memory.set(key, data);
  await writeLocalCache(key, data);
  return data;
}

/**
 * Заранее просит сервер загрузить подробности по списку заданий.
 *
 * Сервер кладёт их в свой кэш в фоне — к моменту клика они уже готовы.
 */
export function preloadDetails(ids) {
  const list = Array.from(new Set((ids || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)));
  if (!list.length) return Promise.resolve(null);
  return api.preloadDetails(list).catch(() => null);
}

async function readLocalCache(key) {
  try {
    const raw = await storageGet(CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data) return null;
    const saved = Date.parse(parsed.savedAt || "");
    if (Number.isFinite(saved) && Date.now() - saved > LOCAL_TTL_MS) return null;
    return parsed.data;
  } catch (_) {
    return null;
  }
}

async function writeLocalCache(key, data) {
  try {
    await storageSet(CACHE_PREFIX + key, JSON.stringify({
      savedAt: new Date().toISOString(),
      data,
    }));
  } catch (_) { /* кэш необязателен */ }
}
