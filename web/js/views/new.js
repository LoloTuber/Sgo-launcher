/**
 * Вкладка «Новое»: всё, что появилось нового — оценки и домашние задания.
 *
 * Список собирает модуль changes.js: там, где новые элементы помечаются
 * как «новые», они же складываются в реестр с датой, предметом и темой.
 * По клику на запись открываем дневник на нужной неделе и подсвечиваем
 * саму запись.
 */

import { escapeHtml, shortDate, markCls, toast } from '../utils.js';
import { getNewItems, newItemsCount } from '../changes.js';
import { openDiaryAt } from './diary.js';

/** Рисует список новых записей. */
export function renderNew() {
  const list = document.querySelector("#new-list");
  if (!list) return;

  const items = getNewItems();
  const sub = document.querySelector("#new-sub");
  if (sub) {
    sub.textContent = items.length
      ? `Новых записей: ${items.length}`
      : "Здесь появляются новые оценки и задания";
  }

  if (!items.length) {
    list.innerHTML = `<div class="empty"><strong>Пока ничего нового</strong>
      Новые оценки и домашние задания появятся здесь автоматически.</div>`;
    return;
  }

  const marks = items.filter((item) => item.kind === "mark");
  const homework = items.filter((item) => item.kind === "homework");

  list.innerHTML = [
    marks.length ? section("Новые оценки", marks.map(markRow)) : "",
    homework.length ? section("Новое домашнее задание", homework.map(homeworkRow)) : "",
  ].join("");

  bindNewItems(list);
}

function section(title, rows) {
  return `
    <div class="new-section">
      <div class="new-section-title">${escapeHtml(title)}</div>
      <div class="new-items">${rows.join("")}</div>
    </div>
  `;
}

function markRow(item) {
  const title = item.topic || item.type || "Оценка";
  return `
    <button class="new-item" type="button"
            data-date="${escapeHtml(item.date || "")}"
            data-mark-id="${escapeHtml(item.markId != null ? item.markId : "")}">
      <span class="mark-value ${markCls(item.value)}">${escapeHtml(item.value)}</span>
      <span class="new-item-main">
        <span class="new-item-title">${escapeHtml(item.subject || "Предмет не указан")}</span>
        <span class="new-item-text">${escapeHtml(title)}</span>
      </span>
      <span class="new-item-date">${escapeHtml(shortDate(item.date))}</span>
    </button>
  `;
}

function homeworkRow(item) {
  const lesson = item.lessonNumber != null ? `${item.lessonNumber}. ` : "";
  return `
    <button class="new-item" type="button"
            data-date="${escapeHtml(item.date || "")}"
            data-task-id="${escapeHtml(item.taskId != null ? item.taskId : "")}">
      <span class="new-item-mark">📘</span>
      <span class="new-item-main">
        <span class="new-item-title">${escapeHtml(lesson + (item.subject || "Домашнее задание"))}</span>
        <span class="new-item-text">${escapeHtml(item.text || "")}</span>
      </span>
      <span class="new-item-date">${escapeHtml(shortDate(item.date))}</span>
    </button>
  `;
}

/** По клику открываем дневник и подсвечиваем выбранную запись. */
function bindNewItems(list) {
  list.onclick = (event) => {
    const button = event.target.closest(".new-item");
    if (!button || !list.contains(button)) return;

    const options = {};
    if (button.dataset.markId) options.markId = button.dataset.markId;
    if (button.dataset.taskId) options.taskId = button.dataset.taskId;

    openDiaryAt(button.dataset.date, options).then((ok) => {
      if (!ok) toast("Запись не найдена в дневнике");
    });
  };
}

/**
 * Подписывает вкладку на обновления: список нужно перерисовывать,
 * когда данные изменились или пользователь отметил всё прочитанным.
 */
export function initNewTab() {
  window.addEventListener("sgo:changes-read", () => {
    if (document.querySelector(".tab[data-tab='new']")?.classList.contains("is-active")) {
      renderNew();
    }
  });

  window.addEventListener("sgo:data-updated", () => {
    if (document.querySelector(".tab[data-tab='new']")?.classList.contains("is-active")) {
      renderNew();
    }
  });
}

export { newItemsCount };
