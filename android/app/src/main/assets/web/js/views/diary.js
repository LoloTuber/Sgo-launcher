import * as api from '../api.js';
import { escapeHtml, shortDate, markCls, formatAverage, isImportantTalkSubject } from '../utils.js';
import { getSettings } from '../settings.js';
import { isNewHomework, isNewMark, newHomeworkCount } from '../changes.js';

/**
 * Дневник: главный акцент — домашнее задание и подробности к нему.
 * Оценки стоят в строке урока (без отдельной карточки): видно отметку,
 * вес и тему работы целиком. По оценке раскрываются подробности —
 * учитель, дата, вес, средний балл класса, оценки класса, комментарий, файлы.
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

  // Дни без единого урока (выходные, каникулы, пустые ответы API) полностью
  // убираем из списка. Раньше для них рисовалась карточка «Уроков нет»,
  // из-за чего суббота и воскресенье занимали пол-экрана.
  const visibleDays = days.map((day) => {
    const allLessons = visibleLessons(day);
    const realLessons = allLessons.filter((lesson) => String(lesson.subject || "").trim());

    if (!realLessons.length) return null;

    return {
      day,
      // При включённой настройке скрываем и отдельные уроки без названия.
      lessons: settings.hideEmptyLessons ? realLessons : allLessons,
    };
  }).filter(Boolean);

  if (!visibleDays.length) {
    const message = settings.hideEmptyLessons
      ? "За эту неделю нет уроков (пустые дни скрыты в настройках)."
      : "За эту неделю дневник пуст.";
    list.innerHTML = `<div class="empty"><strong>Нет данных</strong>${message}</div>`;
    return;
  }

  list.innerHTML = visibleDays.map(({ day, lessons }) => `
      <div class="diary-day" data-date="${escapeHtml(day.date)}">
        <div class="day-header">${escapeHtml(day.weekday)}, ${shortDate(day.date)}</div>
        <div class="day-body">
          ${lessons.map((lesson) => renderLesson(lesson, day.date)).join("")}
        </div>
      </div>
    `).join("");

  list.querySelectorAll(".hw-task-head[data-task-id]").forEach((head) => {
    head.addEventListener("click", () => toggleTask(head));
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleTask(head);
      }
    });
  });

  // Оценки тоже кликабельны: по ним видно, за что поставили отметку.
  list.querySelectorAll(".dl-mark[data-mark-id]").forEach((mark) => {
    mark.addEventListener("click", () => toggleMark(mark));
    mark.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleMark(mark);
      }
    });
  });
}

function renderLesson(lesson, date) {
  const allTasks = uniqueTasks(lesson.tasks);
  const marks = lesson.marks || [];

  // Задание с уже выставленной отметкой не показываем в списке ДЗ:
  // иначе один и тот же текст видно дважды — и в ДЗ, и в оценке.
  // Тема этой работы остаётся в строке оценки.
  const tasks = allTasks.filter((task) =>
    !marks.some((mark) => mark.topic && sameText(mark.topic, task.text))
  );
  const gradedAway = allTasks.length - tasks.length;

  return `
    <div class="diary-lesson">
      <div class="dl-head">
        <span class="dl-num">${escapeHtml(lesson.number)}</span>
        <span class="dl-subj">${escapeHtml(lesson.subject)}</span>
        <span class="dl-time">${escapeHtml(lesson.start)}–${escapeHtml(lesson.end)}</span>
      </div>
      <div class="dl-body">
        ${marks.length ? renderMarks(marks, lesson.subject) : ""}
        <div class="dl-main">
          ${tasks.length
            ? renderTasks(tasks, date, lesson.number)
            : (gradedAway
              ? `<div class="dl-no-hw">Задания отмечены оценкой выше</div>`
              : `<div class="dl-no-hw">Домашнего задания нет</div>`)}
        </div>
      </div>
    </div>
  `;
}

/**
 * Приводит текст к сравнимому виду: без кавычек, лишних пробелов и регистра.
 * Нужно, чтобы понять, что тема оценки — это то же самое задание,
 * что уже показано в списке домашнего задания (и не повторять её дважды).
 */
function sameText(a, b) {
  const norm = (value) => String(value || "")
    .toLowerCase()
    .replace(/["«»“”]/g, "")
    .replace(/[.。\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return !!norm(a) && norm(a) === norm(b);
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
    <div class="dl-marks-row">
      <div class="dl-marks-label">Оценки</div>
      ${marks.map((mark) => {
        const weight = mark.weight > 1
          ? `<span class="weight-badge">x${mark.weight}</span>`
          : "";
        const title = [mark.topic, mark.type].filter(Boolean).join(" · ") || "Оценка";
        const isNew = isNewMark(subjectName, mark);
        const hasId = mark.id !== undefined && mark.id !== null && mark.id !== 0;
        const attrs = hasId
          ? `data-mark-id="${escapeHtml(mark.id)}" data-mark-value="${escapeHtml(mark.value)}" role="button" tabindex="0" aria-expanded="false"`
          : "";
        // Тема работы — это и есть «за что» поставили оценку.
        const label = mark.topic || mark.type || "Оценка";
        return `
          <div class="dl-mark-wrap">
            <div class="dl-mark ${isNew ? "is-new" : ""} ${hasId ? "is-clickable" : ""}"
                 ${attrs} title="${escapeHtml(title)}">
              <span class="mark-value ${markCls(mark.value)}">${escapeHtml(mark.value)}</span>
              ${weight}
              <span class="dl-mark-type">${escapeHtml(label)}</span>
              ${isNew ? `<span class="new-dot" title="Новая оценка"></span>` : ""}
              ${hasId ? `<span class="hw-chevron" aria-hidden="true">›</span>` : ""}
            </div>
            ${hasId ? `<div class="dl-mark-details" hidden></div>` : ""}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

/** Раскрывает подробности оценки: учитель, тема, вес, класс, комментарий, файлы. */
async function toggleMark(markEl) {
  const id = markEl.dataset.markId;
  if (!id) return;

  const wrap = markEl.closest(".dl-mark-wrap");
  const details = wrap && wrap.querySelector(".dl-mark-details");
  if (!details) return;

  const isOpen = markEl.getAttribute("aria-expanded") === "true";
  if (isOpen) {
    markEl.setAttribute("aria-expanded", "false");
    details.hidden = true;
    details.innerHTML = "";
    return;
  }

  if (wrap.classList.contains("loading")) return;

  wrap.classList.add("loading", "open");
  markEl.setAttribute("aria-expanded", "true");
  details.hidden = false;
  details.innerHTML = `<p class="meta">Загружаю подробности…</p>`;

  try {
    const data = await api.getAssignmentDetails(id);
    details.innerHTML = renderDetails(data, markEl.dataset.markValue);
  } catch (error) {
    details.innerHTML = `<p class="hw-error">Не удалось загрузить: ${escapeHtml(error.message)}</p>`;
  } finally {
    wrap.classList.remove("loading");
  }
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
    // Тема задания у домашнего задания совпадает с его текстом — не дублируем.
    if (details) details.innerHTML = renderDetails(data, "", true);
  } catch (error) {
    if (details) {
      details.innerHTML = `<p class="hw-error">Не удалось загрузить: ${escapeHtml(error.message)}</p>`;
    }
  } finally {
    task.classList.remove("loading");
  }
}

/**
 * Подробности по заданию (оценке или домашнему заданию).
 * Показываем всё, что отдаёт СГО: тема, предмет, дата, вес, учитель,
 * средний балл класса, распределение оценок класса, комментарий и файлы.
 */
function renderDetails(data, markValue, skipTopic) {
  const rows = [];
  const add = (label, html) => {
    if (html) rows.push(`<div class="dl-row"><span class="label">${label}</span><span class="value">${html}</span></div>`);
  };

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

/** «2026-11-12» → «12.11.2026». */
function formatDateFull(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!match) return "";
  return `${match[3]}.${match[2]}.${match[1]}`;
}

/**
 * Подсвечивает день по дате и прокручивает к нему.
 * Возвращает true, если такой день есть в списке.
 */
export function highlightDiaryDate(dateIso) {
  const list = document.querySelector("#diary-list");
  const iso = String(dateIso || "");
  if (!list || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;

  list.querySelectorAll(".diary-day.is-highlight").forEach((el) => {
    el.classList.remove("is-highlight");
  });

  const target = list.querySelector(`.diary-day[data-date="${iso}"]`);
  if (!target) return false;

  target.classList.add("is-highlight");
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  setTimeout(() => target.classList.remove("is-highlight"), 4000);
  return true;
}
