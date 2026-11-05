import * as api from '../api.js';
import { escapeHtml, shortDate, markCls, isImportantTalkSubject } from '../utils.js';
import { getSettings } from '../settings.js';
import { isNewHomework, isNewMark, newHomeworkCount } from '../changes.js';

/**
 * Дневник: главный акцент — домашнее задание и подробности к нему.
 * Оценки вынесены в узкую колонку справа и не кликаются.
 * Клик по заданию раскрывает комментарий учителя, тип работы и файлы.
 */
export function renderDiary(data) {
  const list = document.querySelector("#diary-list");
  const settings = getSettings();

  // «Разговоры о важном» в дневнике не показываем.
  const visibleLessons = (day) => (day.lessons || [])
    .filter((lesson) => !isImportantTalkSubject(lesson.subject));

  if (data.weekStart && data.weekEnd) {
    const fresh = newHomeworkCount();
    document.querySelector("#diary-label").textContent =
      `Неделя ${shortDate(data.weekStart)} – ${shortDate(data.weekEnd)}` +
      (fresh ? ` · новых заданий: ${fresh}` : "");
  }

  let days = data.days || [];
  if (settings.hideEmptyLessons) {
    days = days.filter((day) =>
      visibleLessons(day).some((lesson) => String(lesson.subject || "").trim())
    );
  }

  if (!days.length) {
    const message = settings.hideEmptyLessons
      ? "За эту неделю нет уроков (пустые дни скрыты в настройках)."
      : "За эту неделю дневник пуст.";
    list.innerHTML = `<div class="empty"><strong>Нет данных</strong>${message}</div>`;
    return;
  }

  list.innerHTML = days.map((day) => {
    let lessons = visibleLessons(day);
    if (settings.hideEmptyLessons) {
      lessons = lessons.filter((lesson) => String(lesson.subject || "").trim());
    }

    if (!lessons.length) {
      return `
        <div class="diary-day">
          <div class="day-header">${escapeHtml(day.weekday)}, ${shortDate(day.date)}</div>
          <div class="day-body" style="color:var(--ink-soft);font-style:italic;">Уроков нет</div>
        </div>
      `;
    }

    return `
      <div class="diary-day">
        <div class="day-header">${escapeHtml(day.weekday)}, ${shortDate(day.date)}</div>
        <div class="day-body">
          ${lessons.map((lesson) => renderLesson(lesson, day.date)).join("")}
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".hw-task-head[data-task-id]").forEach((head) => {
    head.addEventListener("click", () => toggleTask(head));
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleTask(head);
      }
    });
  });
}

function renderLesson(lesson, date) {
  const tasks = uniqueTasks(lesson.tasks);
  const marks = lesson.marks || [];

  return `
    <div class="diary-lesson">
      <div class="dl-head">
        <span class="dl-num">${escapeHtml(lesson.number)}</span>
        <span class="dl-subj">${escapeHtml(lesson.subject)}</span>
        <span class="dl-time">${escapeHtml(lesson.start)}–${escapeHtml(lesson.end)}</span>
      </div>
      <div class="dl-body">
        <div class="dl-main">
          ${tasks.length
            ? renderTasks(tasks, date, lesson.number)
            : `<div class="dl-no-hw">Домашнего задания нет</div>`}
        </div>
        ${marks.length ? renderMarks(marks, lesson.subject) : ""}
      </div>
    </div>
  `;
}

/** Убираем повторы заданий, сохраняя порядок. */
function uniqueTasks(tasks) {
  const seen = new Set();
  const result = [];
  for (const task of tasks || []) {
    const text = String(task.text || "").trim();
    if (!text) continue;
    const key = task.id ? `id:${task.id}` : `text:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...task, text });
  }
  return result;
}

function renderTasks(tasks, date, lessonNumber) {
  return `
    <div class="dl-hw">
      <div class="hw-title">Домашнее задание</div>
      <div class="hw-tasks">
        ${tasks.map((task) => {
          const hasId = task.id !== undefined && task.id !== null && task.id !== 0;
          const attrs = hasId
            ? `data-task-id="${escapeHtml(task.id)}" role="button" tabindex="0" aria-expanded="false"`
            : "";
          const isNew = isNewHomework(date, lessonNumber, task);
          return `
            <div class="hw-task ${hasId ? "is-clickable" : ""} ${isNew ? "is-new" : ""}">
              <div class="hw-task-head" ${attrs}>
                <span class="hw-task-text">${escapeHtml(task.text)}</span>
                ${isNew ? `<span class="new-badge">новое</span>` : ""}
                ${task.type ? `<span class="hw-type">${escapeHtml(task.type)}</span>` : ""}
                ${hasId ? `<span class="hw-chevron" aria-hidden="true">›</span>` : ""}
              </div>
              ${hasId ? `<div class="hw-details" hidden></div>` : ""}
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function renderMarks(marks, subjectName) {
  return `
    <aside class="dl-marks" aria-label="Оценки за урок">
      <div class="dl-marks-title">Оценки</div>
      ${marks.map((mark) => {
        const weight = mark.weight > 1
          ? `<span class="weight-badge">x${mark.weight}</span>`
          : "";
        const title = [mark.topic, mark.type].filter(Boolean).join(" · ") || "Оценка";
        const isNew = isNewMark(subjectName, mark);
        return `
          <div class="dl-mark ${isNew ? "is-new" : ""}" title="${escapeHtml(title)}">
            <span class="mark-value ${markCls(mark.value)}">${escapeHtml(mark.value)}</span>
            ${weight}
            <span class="dl-mark-type">${escapeHtml(mark.type || "Оценка")}</span>
            ${isNew ? `<span class="new-dot" title="Новая оценка"></span>` : ""}
          </div>
        `;
      }).join("")}
    </aside>
  `;
}

async function toggleTask(head) {
  const task = head.closest(".hw-task");
  const id = head.dataset.taskId;
  if (!task || !id) return;

  const details = task.querySelector(".hw-details");
  const isOpen = task.classList.contains("open");

  if (isOpen) {
    task.classList.remove("open");
    head.setAttribute("aria-expanded", "false");
    if (details) {
      details.hidden = true;
      details.innerHTML = "";
    }
    return;
  }

  if (task.classList.contains("loading")) return;

  task.classList.add("loading", "open");
  head.setAttribute("aria-expanded", "true");
  if (details) {
    details.hidden = false;
    details.innerHTML = `<p class="meta">Загружаю подробности…</p>`;
  }

  try {
    const data = await api.getAssignmentDetails(id);
    if (details) details.innerHTML = renderDetails(data);
  } catch (error) {
    if (details) {
      details.innerHTML = `<p class="hw-error">Не удалось загрузить: ${escapeHtml(error.message)}</p>`;
    }
  } finally {
    task.classList.remove("loading");
  }
}

function renderDetails(data) {
  const parts = [];

  if (data.teachers && data.teachers.length) {
    parts.push(
      `<p><span class="label">Учитель:</span> ${escapeHtml(data.teachers.join(", "))}</p>`
    );
  }

  (data.details || []).forEach((text) => {
    parts.push(`<p><span class="label">Комментарий:</span> ${escapeHtml(text)}</p>`);
  });

  if (data.files && data.files.length) {
    parts.push(
      `<div class="files">${data.files
        .map((file) => `<span class="file">📎 ${escapeHtml(file)}</span>`)
        .join("")}</div>`
    );
  }

  if (!parts.length) {
    parts.push(`<p class="meta">Дополнительных сведений нет.</p>`);
  }

  return parts.join("");
}
