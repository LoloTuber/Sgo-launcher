import { state } from '../state.js';
import {
  escapeHtml, shortDate, markCls, localIsoDate, addDaysIso, capitalize, toast,
  isImportantTalkSubject, formatAverage, isDebtMark,
} from '../utils.js';
import {
  getScheduleNow, getNextSchoolDay, editScheduleNote, formatScheduleNote, formatLeft,
} from './schedule.js';
import { subjectAverage, overallAverage, valueOf } from '../weights.js';
import {
  isNewMark, isNewHomework, isDayChanged, markAllRead,
  newMarksCount, newHomeworkCount, changedDaysCount,
} from '../changes.js';
import { getHomeLayout, visibleModules, getGridColumns, getModuleSpan, setModuleOrder, getModuleHeight, setModuleHeight, moduleTitle, MIN_HEIGHT } from '../modules.js';
import { renderNotesModule, bindNotesModule } from './notes.js';
import { renderImageModule, bindImageModule, loadImageInfo, ensureImageInfo, getImageInfo } from './image.js';

/**
 * Главный экран: собирается из модулей (расписание, завтра, домашнее
 * задание, оценки, сводка, внимание, заметки, изображение).
 *
 * Состав и порядок модулей задаёт пользователь в настройках
 * (вкладка «Главная»), здесь мы только рендерим их.
 */

function navigate(tab) {
  window.dispatchEvent(new CustomEvent("sgo:navigate", { detail: { tab } }));
}

function goButton(tab, label) {
  return `<button class="btn btn-outline today-go" type="button" data-go="${tab}">${label}</button>`;
}

function uniqueTasks(tasks) {
  const seen = new Set();
  const result = [];
  for (const task of tasks || []) {
    const text = String(task && task.text || "").trim();
    if (!text) continue;
    const key = task.id ? `id:${task.id}` : `text:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...task, text });
  }
  return result;
}

function lessonWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "урок";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "урока";
  return "уроков";
}

function taskWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "задание";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "задания";
  return "заданий";
}

function scheduleActions(date) {
  return `<div class="today-card-actions">
    <button class="btn-edit-note" type="button" data-edit-note="${escapeHtml(date)}" title="Изменить расписание">✏️</button>
    ${goButton("schedule", "Вся неделя")}
  </div>`;
}

/** Если сегодня уроков нет — показываем ближайший учебный день. */
function nextDayScheduleCard(info) {
  const next = getNextSchoolDay(localIsoDate());
  if (!next) {
    return `
      <article class="today-card today-schedule-card">
        <div class="today-card-head"><h3>Расписание</h3>${scheduleActions(localIsoDate())}</div>
        <div class="today-now is-done"><strong>${escapeHtml(info && info.html || "На сегодня уроков нет.")}</strong></div>
        <div class="today-muted">Расписание на следующий учебный день пока не загружено.</div>
      </article>
    `;
  }

  const title = next.isTomorrow ? "Завтра" : `${next.weekday}, ${shortDate(next.date)}`;
  const lessons = next.lessons.filter((lesson) => String(lesson.subject || "").trim());
  const note = next.note ? formatScheduleNote(next.note, next.bells) : "";

  return `
    <article class="today-card today-schedule-card today-next-day ${isDayChanged(next.date) ? "is-changed" : ""}">
      <div class="today-card-head">
        <h3>Расписание · ${escapeHtml(title)}</h3>
        ${scheduleActions(next.date)}
      </div>
      <div class="today-now is-next">
        <span class="today-now-label">Сегодня уроков нет</span>
        <strong>${escapeHtml(title)} · ${lessons.length} ${lessonWord(lessons.length)}</strong>
        <span class="today-now-meta">${escapeHtml(shortDate(next.date))}${lessons[0] ? ` · начало в ${escapeHtml(lessons[0].timeLabel)}` : ""}</span>
      </div>
      ${lessons.length ? `<div class="today-lessons">${lessons.map((lesson) => `
        <div class="today-lesson">
          <span class="today-lesson-num">${lesson.number}</span>
          <span class="today-lesson-subject">${escapeHtml(lesson.subject || "—")}</span>
          <span class="today-lesson-time">${escapeHtml(lesson.timeLabel)}</span>
        </div>`).join("")}</div>` : ""}
      ${note ? `<div class="today-note">${escapeHtml(note)}</div>` : ""}
    </article>
  `;
}

function scheduleCard(info) {
  if (!info || info.status === "no-data") {
    return `
      <article class="today-card today-schedule-card">
        <div class="today-card-head"><h3>Расписание</h3>${goButton("schedule", "Вся неделя")}</div>
        <div class="skeleton"></div>
      </article>
    `;
  }

  // На сегодня уроков нет (или воскресенье) — показываем ближайший день.
  if (info.status === "no-lessons" || info.status === "sunday") {
    return nextDayScheduleCard(info);
  }

  let headline = "";
  if (info.status === "lesson" && info.current) {
    headline = `
      <div class="today-now">
        <span class="today-now-label">Сейчас идёт</span>
        <strong>${escapeHtml(info.current.subject || "Урок")}</strong>
        <span class="today-now-meta">${info.current.number}-й урок · ${escapeHtml(info.current.timeLabel)}</span>
        <span class="today-countdown">до конца ${formatLeft(info.minutesLeft)}</span>
      </div>
    `;
  } else if ((info.status === "before" || info.status === "break") && info.next) {
    headline = `
      <div class="today-now is-next">
        <span class="today-now-label">${info.status === "break" ? "После перемены" : "Скоро начнётся"}</span>
        <strong>${escapeHtml(info.next.subject || "Урок")}</strong>
        <span class="today-now-meta">${info.next.number}-й урок · ${escapeHtml(info.next.timeLabel)}</span>
        <span class="today-countdown">через ${formatLeft(info.minutesLeft)}</span>
      </div>
    `;
  } else {
    headline = `<div class="today-now is-done"><strong>${info.html}</strong></div>`;
  }

  const todayIso = localIsoDate();
  const relevant = (info.lessons || [])
    .filter((lesson) => lesson.state === "current" || lesson.state === "next" || lesson.state === "upcoming")
    .slice(0, 4);

  const lessons = relevant.length
    ? `<div class="today-lessons">${relevant.map((lesson) => `
        <div class="today-lesson ${lesson.state === "current" ? "is-current" : ""}">
          <span class="today-lesson-num">${lesson.number}</span>
          <span class="today-lesson-subject">${escapeHtml(lesson.subject || "—")}</span>
          <span class="today-lesson-time">${escapeHtml(lesson.timeLabel)}</span>
        </div>
      `).join("")}</div>`
    : "";

  const note = info.note ? formatScheduleNote(info.note, info.day && info.day.bells) : "";

  return `
    <article class="today-card today-schedule-card ${isDayChanged(todayIso) ? "is-changed" : ""}">
      <div class="today-card-head">
        <h3>Расписание</h3>
        ${scheduleActions(todayIso)}
      </div>
      ${headline}
      ${lessons}
      ${note ? `<div class="today-note">${escapeHtml(note)}</div>` : ""}
    </article>
  `;
}

/** Уроки завтрашнего дня: из текущей или следующей недели. */
function tomorrowScheduleCard() {
  const tomorrow = addDaysIso(localIsoDate(), 1);
  const weeks = [state.schedule, state.nextSchedule];
  let day = null;
  for (const week of weeks) {
    if (!week || !Array.isArray(week.days)) continue;
    day = week.days.find((item) => item.date === tomorrow) || null;
    if (day) break;
  }

  const actions = `<div class="today-card-actions">
    <button class="btn-edit-note" type="button" data-edit-note="${escapeHtml(tomorrow)}" title="Изменить расписание">✏️</button>
    ${goButton("schedule", "Вся неделя")}
  </div>`;

  if (!day) {
    const next = getNextSchoolDay(localIsoDate());
    return `
      <article class="today-card home-tomorrow-card">
        <div class="today-card-head"><h3>Расписание на завтра</h3>${actions}</div>
        <div class="today-muted">
          ${next
            ? `Завтра уроков нет. Ближайший учебный день — ${escapeHtml(next.weekday.toLowerCase())}, ${escapeHtml(shortDate(next.date))}.`
            : "Расписание на завтра пока не загружено."}
        </div>
      </article>
    `;
  }

  const lessons = (day.lessons || [])
    .filter((lesson) => String(lesson.subject || "").trim())
    .filter((lesson) => !isImportantTalkSubject(lesson.subject))
    .sort((a, b) => Number(a.number) - Number(b.number));

  const body = lessons.length
    ? `<div class="today-lessons">${lessons.map((lesson) => `
        <div class="today-lesson">
          <span class="today-lesson-num">${lesson.number}</span>
          <span class="today-lesson-subject">${escapeHtml(lesson.subject || "—")}</span>
          <span class="today-lesson-time">${escapeHtml(lessonTime(lesson))}</span>
        </div>`).join("")}</div>`
    : `<div class="today-muted">Завтра уроков нет.</div>`;

  return `
    <article class="today-card home-tomorrow-card ${isDayChanged(tomorrow) ? "is-changed" : ""}">
      <div class="today-card-head">
        <h3>Расписание на завтра</h3>
        ${actions}
      </div>
      <div class="today-now-meta">${escapeHtml(day.weekday || "")}, ${escapeHtml(shortDate(tomorrow))} · ${lessons.length} ${lessonWord(lessons.length)}</div>
      ${body}
    </article>
  `;
}

/** Время урока: «08:00–08:40» либо только начало. */
function lessonTime(lesson) {
  const start = String(lesson.start || "").trim();
  const end = String(lesson.end || "").trim();
  if (start && end) return `${start}–${end}`;
  return start || end || "";
}

function todayHomework() {
  if (!state.diary || !Array.isArray(state.diary.days)) return null;
  const today = localIsoDate();
  const day = state.diary.days.find((item) => item.date === today) || null;
  if (!day) return { date: today, weekday: "", lessons: [] };

  const lessons = (day.lessons || [])
    .filter((lesson) => !isImportantTalkSubject(lesson.subject))
    .map((lesson) => ({
      ...lesson,
      tasks: uniqueTasks(lesson.tasks),
    }))
    .filter((lesson) => lesson.tasks.length);

  return { date: today, weekday: day.weekday, lessons };
}

function tomorrowHomework() {
  const homework = state.quick && state.quick.homework;
  if (!homework) return null;
  const date = homework.date || addDaysIso(localIsoDate(), 1);
  const lessons = (homework.lessons || [])
    .filter((lesson) => !isImportantTalkSubject(lesson.subject))
    .map((lesson) => ({ ...lesson, tasks: uniqueTasks(lesson.tasks) }))
    .filter((lesson) => lesson.tasks.length);
  return { ...homework, date, lessons };
}

function homeworkCard() {
  const today = todayHomework();
  const tomorrow = tomorrowHomework();

  let todayHtml = "";
  if (!today) {
    todayHtml = `<div class="today-muted">Дневник за эту неделю ещё не загружен.</div>`;
  } else if (!today.lessons.length) {
    todayHtml = `<div class="today-muted">На сегодня домашнего задания нет.</div>`;
  } else {
    const total = today.lessons.reduce((sum, lesson) => sum + lesson.tasks.length, 0);
    todayHtml = `
      <div class="today-hw-summary">Сегодня · ${total} ${taskWord(total)}</div>
      ${today.lessons.map((lesson) => `
        <div class="today-hw-lesson">
          <div class="today-hw-subject">${lesson.number}. ${escapeHtml(lesson.subject)}</div>
          ${lesson.tasks.map((task) => {
            const fresh = isNewHomework(today.date, lesson.number, task);
            return `<div class="today-hw-task ${fresh ? "is-new" : ""}">
              <span>${escapeHtml(task.text)}</span>
              ${fresh ? `<span class="new-badge">новое</span>` : ""}
            </div>`;
          }).join("")}
        </div>
      `).join("")}
    `;
  }

  let tomorrowHtml = "";
  if (tomorrow && tomorrow.lessons.length) {
    const total = tomorrow.lessons.reduce((sum, lesson) => sum + lesson.tasks.length, 0);
    tomorrowHtml = `
      <details class="today-hw-tomorrow">
        <summary>На завтра · ${total} ${taskWord(total)}</summary>
        ${tomorrow.lessons.map((lesson) => `
          <div class="today-hw-lesson">
            <div class="today-hw-subject">${lesson.number}. ${escapeHtml(lesson.subject)}</div>
            ${lesson.tasks.map((task) => {
              const fresh = isNewHomework(tomorrow.date, lesson.number, task);
              return `<div class="today-hw-task ${fresh ? "is-new" : ""}">
                <span>${escapeHtml(task.text)}</span>
                ${fresh ? `<span class="new-badge">новое</span>` : ""}
              </div>`;
            }).join("")}
          </div>
        `).join("")}
      </details>
    `;
  } else {
    tomorrowHtml = `<div class="today-muted">На завтра заданий пока нет.</div>`;
  }

  return `
    <article class="today-card today-hw-card">
      <div class="today-card-head">
        <h3>Домашнее задание</h3>
        ${goButton("diary", "Дневник")}
      </div>
      ${todayHtml}
      ${tomorrowHtml}
    </article>
  `;
}

function latestGradesCard() {
  const rows = [];
  for (const subject of (state.grades && state.grades.subjects) || []) {
    for (const mark of subject.marks || []) {
      rows.push({ subject: subject.name, mark });
    }
  }

  rows.sort((a, b) => String(b.mark.date || "").localeCompare(String(a.mark.date || "")));
  const latest = rows.slice(0, 6);

  if (!latest.length) {
    return `
      <article class="today-card">
        <div class="today-card-head"><h3>Последние оценки</h3>${goButton("grades", "Все оценки")}</div>
        <div class="today-muted">Оценок пока нет.</div>
      </article>
    `;
  }

  return `
    <article class="today-card">
      <div class="today-card-head"><h3>Последние оценки</h3>${goButton("grades", "Все оценки")}</div>
      <div class="today-grades">
        ${latest.map(({ subject, mark }) => {
          const fresh = isNewMark(subject, mark);
          const isDot = mark.value === "." || mark.value === "-";
          return `
            <div class="today-grade ${fresh ? "is-new" : ""}">
              <span class="mark-value ${markCls(mark.value)}">${escapeHtml(mark.value)}</span>
              <div class="today-grade-main">
                <span class="today-grade-subject">${escapeHtml(subject)}</span>
                <span class="today-grade-topic">${escapeHtml(mark.topic || mark.type || (isDot ? "Долг" : "Оценка"))}</span>
              </div>
              <span class="today-grade-date">${escapeHtml(shortDate(mark.date))}</span>
              ${fresh ? `<span class="new-dot" title="Новая оценка"></span>` : ""}
            </div>
          `;
        }).join("")}
      </div>
    </article>
  `;
}

/** Сводка: средний балл, сколько оценок, долги, предметы в риске. */
function summaryCard() {
  const grades = state.grades || {};
  const subjects = grades.subjects || [];
  let marks = 0;
  let debts = 0;
  let risky = 0;
  const riskyNames = [];
  // Предметы, в которых есть хоть одна оценка: сервер ПК отдаёт все предметы
  // периода, Android — только с оценками, поэтому считаем одинаково.
  let subjectsWithMarks = 0;

  for (const subject of subjects) {
    let subjectMarks = 0;
    for (const mark of subject.marks || []) {
      // Долг («.»/«-») — это долг, а не числовая оценка, в счёт не идёт.
      if (isDebtMark(mark && mark.value)) {
        debts += 1;
        continue;
      }
      if (valueOf(mark) != null) {
        marks += 1;
        subjectMarks += 1;
      }
    }
    if (subjectMarks) subjectsWithMarks += 1;
    // Средние из СГО весов не учитывают, поэтому риск считаем сами.
    const ownAverage = subjectAverage(subject);
    if (ownAverage != null && ownAverage < 3.5) {
      risky += 1;
      riskyNames.push(subject.name);
    }
  }

  // Средний балл — взвешенный, как в шапке, чтобы числа не расходились.
  const average = overallAverage(subjects);
  const shownAverage = average != null ? average : grades.average;

  const tiles = [
    `<div class="home-summary-item">
       <span class="home-summary-value">${escapeHtml(formatAverage(shownAverage))}</span>
       <span class="home-summary-label">средний балл</span>
     </div>`,
    `<div class="home-summary-item">
       <span class="home-summary-value">${marks}</span>
       <span class="home-summary-label">${markWord(marks)}</span>
     </div>`,
    `<div class="home-summary-item">
       <span class="home-summary-value">${subjectsWithMarks}</span>
       <span class="home-summary-label">${subjectWord(subjectsWithMarks)}</span>
     </div>`,
  ];

  if (debts) {
    tiles.push(`<div class="home-summary-item is-warn">
       <span class="home-summary-value">${debts}</span>
       <span class="home-summary-label">${debtWord(debts)}</span>
     </div>`);
  }
  if (risky) {
    tiles.push(`<div class="home-summary-item is-warn">
       <span class="home-summary-value">${risky}</span>
       <span class="home-summary-label">${riskWord(risky)}</span>
     </div>`);
  }

  const period = grades.term ? ` · ${escapeHtml(grades.term)}` : "";
  const riskNote = risky
    ? `<div class="home-summary-note">В зоне риска: ${escapeHtml(riskyNames.slice(0, 3).join(", "))}${riskyNames.length > 3 ? " и другие" : ""}.</div>`
    : "";

  return `
    <article class="today-card home-summary-card">
      <div class="today-card-head"><h3>Сводка</h3>${goButton("analytics", "Подробнее")}</div>
      <div class="home-summary">${tiles.join("")}</div>
      <div class="home-summary-note">Данные за период${period}.</div>
      ${riskNote}
    </article>
  `;
}

/** «4 оценки», «1 оценка» — правильное окончание. */
function markWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "оценка";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "оценки";
  return "оценок";
}

/** «18 предметов», «1 предмет» — правильное окончание. */
function subjectWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "предмет";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "предмета";
  return "предметов";
}

/** «2 долга», «1 долг» — правильное окончание. */
function debtWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "долг";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "долга";
  return "долгов";
}

/** «1 предмет в риске», «2 предмета в риске», «5 предметов в риске». */
function riskWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "предмет в риске";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "предмета в риске";
  return "предметов в риске";
}

function attentionCard() {
  const debts = [];
  const risky = [];

  for (const subject of (state.grades && state.grades.subjects) || []) {
    const marks = subject.marks || [];
    marks.forEach((mark) => {
      if (mark.value === "." || mark.value === "-") {
        debts.push({ subject: subject.name, mark });
      }
    });
    // Средние из СГО весов не учитывают, поэтому риск считаем сами:
    // взвешенное среднее по оценкам предмета (долг = 2).
    const ownAverage = subjectAverage(subject);
    if (ownAverage != null && ownAverage < 3.5) {
      risky.push({ name: subject.name, average: ownAverage });
    }
  }

  if (!debts.length && !risky.length) {
    return `
      <article class="today-card today-attention is-ok">
        <div class="today-card-head"><h3>Требует внимания</h3>${goButton("analytics", "Аналитика")}</div>
        <div class="today-muted">Долгов нет, предметы вне зоны риска. ✅</div>
      </article>
    `;
  }

  return `
    <article class="today-card today-attention">
      <div class="today-card-head"><h3>Требует внимания</h3>${goButton("analytics", "Аналитика")}</div>
      ${debts.length ? `
        <div class="today-attention-title">Неисправленные долги · ${debts.length}</div>
        ${debts.slice(0, 4).map(({ subject, mark }) => `
          <div class="today-debt">
            <span class="mark-value m0">${escapeHtml(mark.value)}</span>
            <div>
              <strong>${escapeHtml(subject)}</strong>
              <small>${escapeHtml(shortDate(mark.date))} · ${escapeHtml(mark.topic || "Без темы")}</small>
            </div>
          </div>
        `).join("")}
      ` : ""}
      ${risky.length ? `
        <div class="today-attention-title">Средний ниже 3,5</div>
        <div class="today-risk-chips">
          ${risky.map((item) => `<span class="today-risk-chip">${escapeHtml(item.name)} · ${formatAverage(item.average)}</span>`).join("")}
        </div>
      ` : ""}
    </article>
  `;
}

/**
 * Добавляет в карточку модуля ручку для перетаскивания.
 * Ручки показываются только в режиме редактирования — в обычном виде
 * главный экран не должен выглядеть служебным.
 */
function withDragHandle(html) {
  return String(html || "").replace(
    "<h3>",
    '<h3><span class="home-module-handle" draggable="true" title="Перетащите, чтобы поменять модули местами" aria-label="Перетащить модуль">⋮⋮</span> ',
  );
}

/**
 * Ручка изменения высоты — в правом нижнем углу модуля.
 * Показывается только в режиме редактирования.
 */
function withResizeGrip(html) {
  return `${String(html || "")}<button class="home-module-resize" type="button"
    title="Изменить высоту модуля" aria-label="Изменить высоту модуля">⠿</button>`;
}

// Режим редактирования: показываем ручки и подсказку про перетаскивание.
let editMode = false;

/** Включает/выключает режим редактирования главного экрана. */
export function setHomeEditMode(on) {
  editMode = !!on;
  renderHome();
}

/** Текущий режим редактирования. */
export function isHomeEditMode() {
  return editMode;
}

/**
 * Сколько колонок реально помещается на экране.
 * Пользователь выбирает, сколько колонок хочет, но на узком окне
 * три колонки читать невозможно — там оставляем одну или две.
 */
function effectiveColumns(columns) {
  const width = window.innerWidth || 1200;
  if (width < 560) return 1;
  if (width < 1000) return Math.min(columns, 2);
  return columns;
}

/** Реестр модулей главного экрана: id → функция разметки. */
const MODULES = {
  schedule: () => scheduleCard(getScheduleNow()),
  tomorrow: tomorrowScheduleCard,
  homework: homeworkCard,
  grades: latestGradesCard,
  summary: summaryCard,
  attention: attentionCard,
  notes: renderNotesModule,
  image: renderImageModule,
};

export function renderHome() {
  const content = document.querySelector("#home-content");
  if (!content) return;

  // Сведения о сохранённой картинке загружаем один раз — иначе модуль
  // «Изображение» не знает, что картинка уже есть.
  if (!getImageInfo()) {
    ensureImageInfo().then(() => {
      if (state.tab === "home") renderHome();
    });
  }

  const now = new Date();
  setHomeDate(now);
  const freshMarks = newMarksCount();
  const freshHomework = newHomeworkCount();
  const freshSchedule = changedDaysCount();
  const freshTotal = freshMarks + freshHomework + freshSchedule;

  const freshHtml = freshTotal
    ? `<div class="today-fresh">
        ${freshMarks ? `<span>✦ Новых оценок: ${freshMarks}</span>` : ""}
        ${freshHomework ? `<span>✦ Новых заданий: ${freshHomework}</span>` : ""}
        ${freshSchedule ? `<span>✦ Расписание изменилось</span>` : ""}
        <button class="today-read-all" type="button" data-action="mark-read">Отметить всё прочитанным</button>
      </div>`
    : "";

  const layout = getHomeLayout();
  const ids = visibleModules(layout);
  const columns = effectiveColumns(getGridColumns(layout));
  const body = ids
    .map((id) => {
      const render = MODULES[id];
      if (!render) return "";
      const html = render();
      if (!html) return "";
      const span = Math.min(getModuleSpan(id, layout), columns);
      const height = getModuleHeight(id, layout);
      const card = editMode ? withResizeGrip(withDragHandle(html)) : html;
      const style = `--span: ${span};${height ? ` --module-height: ${height}px;` : ""}`;
      const cls = `home-module${height ? " has-height" : ""}`;
      return `<section class="${cls}" data-module="${id}" style="${style}">${card}</section>`;
    })
    .join("");

  const editHint = editMode
    ? `<div class="home-edit-hint">Режим перетаскивания: тяните модуль за ручку «⋮⋮» — на его месте появится рамка, куда он встанет. За угол «⠿» тяните, чтобы изменить высоту модуля.</div>`
    : "";

  content.classList.toggle("is-editing", editMode);
  content.innerHTML = `${freshHtml}${editHint}<div class="home-grid" style="--home-cols: ${columns}">${body}</div>`;

  bindHomeGrid(content);
  bindNotesModule(content);
  bindImageModule(content, () => renderHome());

  // Делегирование: карточка расписания может обновляться отдельно от экрана.
  content.onclick = (event) => {
    const readAll = event.target.closest("[data-action='mark-read']");
    if (readAll && content.contains(readAll)) {
      markAllRead();
      renderHome();
      toast("Отмечено прочитанным");
      window.dispatchEvent(new CustomEvent("sgo:changes-read"));
      return;
    }

    const editNote = event.target.closest("[data-edit-note]");
    if (editNote && content.contains(editNote)) {
      if (editScheduleNote(editNote.dataset.editNote)) renderHome();
      return;
    }

    const button = event.target.closest("[data-go]");
    if (button && content.contains(button)) navigate(button.dataset.go);
  };
}

/**
 * Перетаскивание модулей прямо на главном экране.
 *
 * Тянуть можно за ручку «⋮⋮» в шапке модуля — так текст в заметках
 * по-прежнему выделяется мышью, а кнопки внутри карточек работают.
 *
 * Пока модуль тянут, на его месте в сетке стоит рамка — она показывает,
 * куда модуль встанет после отпускания.
 */
function bindHomeGrid(container) {
  const grid = container.querySelector(".home-grid");
  if (!grid) return;

  let dragId = null;
  let draggedEl = null;
  let frame = null;       // рамка-место поверх сетки
  let targetEl = null;    // модуль, к которому подводится модуль
  let insertAfter = false; // вставлять перед модулем или после него

  const removeFrame = () => {
    if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
    frame = null;
    targetEl = null;
  };

  /** Рамка-место: показывает ячейку, в которую встанет модуль. */
  const showFrame = (rect, title) => {
    if (!frame) {
      frame = document.createElement("div");
      frame.className = "home-module-frame";
      grid.appendChild(frame);
    }
    const gridRect = grid.getBoundingClientRect();
    frame.style.left = `${Math.round(rect.left - gridRect.left)}px`;
    frame.style.top = `${Math.round(rect.top - gridRect.top)}px`;
    frame.style.width = `${Math.round(rect.width)}px`;
    frame.style.height = `${Math.round(rect.height)}px`;
    frame.textContent = title;
  };

  const updateFrame = (x, y) => {
    if (!draggedEl) return;
    const found = moduleUnderPointer(grid, x, y, draggedEl);
    if (!found) {
      removeFrame();
      return;
    }
    const module = found.module;
    const rect = module.getBoundingClientRect();
    const wide = rowIsWide(grid, module);
    // В сетке из нескольких колонок решает горизонталь, в одной — вертикаль.
    insertAfter = wide
      ? x > rect.left + rect.width / 2
      : y > rect.top + rect.height / 2;

    targetEl = module;
    const cell = insertAfter ? cellAfter(grid, module) : rect;
    if (cell) showFrame(cell, `«${moduleTitle(draggedEl.dataset.module)}» — сюда`);
  };

  grid.querySelectorAll(".home-module").forEach((section) => {
    section.addEventListener("dragstart", (event) => {
      dragId = section.dataset.module;
      draggedEl = section;
      section.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        try { event.dataTransfer.setData("text/plain", dragId); } catch (_) { /* ignore */ }
      }
    });

    section.addEventListener("dragend", () => {
      section.classList.remove("is-dragging");
      removeFrame();
      dragId = null;
      draggedEl = null;
    });
  });

  grid.addEventListener("dragover", (event) => {
    if (!dragId || !draggedEl) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    updateFrame(event.clientX, event.clientY);
  });

  grid.addEventListener("drop", (event) => {
    event.preventDefault();
    if (draggedEl && targetEl && targetEl !== draggedEl && targetEl.parentNode === grid) {
      if (insertAfter) grid.insertBefore(draggedEl, targetEl.nextElementSibling);
      else grid.insertBefore(draggedEl, targetEl);
    }
    removeFrame();
    dragId = null;
    draggedEl = null;

    const ids = Array.from(grid.querySelectorAll(".home-module"))
      .map((el) => el.dataset.module)
      .filter(Boolean);
    setModuleOrder(ids);
    renderHome();
  });

  bindResizeHandles(container);
}

/** Модуль, под которым оказался указатель (кроме перетаскиваемого). */
function moduleUnderPointer(grid, x, y, draggedEl) {
  let el = null;
  if (typeof document.elementFromPoint === "function") {
    const hit = document.elementFromPoint(x, y);
    el = hit && hit.closest ? hit.closest(".home-module") : null;
  }
  if (!el) {
    // Запасной вариант: перебираем модули и ищем тот, в чей прямоугольник попал указатель.
    el = Array.from(grid.querySelectorAll(".home-module")).find((item) => {
      if (item === draggedEl) return false;
      const rect = item.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
  }
  if (!el || el === draggedEl) return null;
  return { module: el };
}

/** В строке больше одного модуля — значит сетка многоколоночная. */
function rowIsWide(grid, module) {
  const rect = module.getBoundingClientRect();
  let count = 0;
  for (const item of grid.querySelectorAll(".home-module")) {
    const itemRect = item.getBoundingClientRect();
    if (Math.abs(itemRect.top - rect.top) < 8) count += 1;
  }
  return count > 1;
}

/**
 * Ячейка, которая окажется после модуля: следующий модуль в сетке,
 * а если его нет — пустое место справа или снизу.
 */
function cellAfter(grid, module) {
  let next = module.nextElementSibling;
  while (next && !next.classList.contains("home-module")) next = next.nextElementSibling;
  if (next) return next.getBoundingClientRect();

  const rect = module.getBoundingClientRect();
  const gridRect = grid.getBoundingClientRect();
  const style = window.getComputedStyle ? window.getComputedStyle(grid) : null;
  const gap = style ? (parseFloat(style.columnGap) || 12) : 12;
  const columns = style
    ? style.gridTemplateColumns.split(" ").filter(Boolean).length
    : 1;
  const cellWidth = (rect.width + gap) * columns;
  const used = rect.right - gridRect.left + gap;
  const rowFull = used >= cellWidth - 1;
  if (!rowFull) {
    return {
      left: rect.right + gap, top: rect.top, width: rect.width, height: rect.height,
      right: rect.right + gap + rect.width, bottom: rect.bottom,
    };
  }
  return {
    left: gridRect.left, top: rect.bottom + gap, width: rect.width, height: rect.height,
    right: gridRect.left + rect.width, bottom: rect.bottom + gap + rect.height,
  };
}

/**
 * Ручка в углу модуля меняет его высоту: тянешь вниз — карточка растёт.
 * Высота сохраняется, поэтому переживает перезапуск приложения.
 */
function bindResizeHandles(container) {
  container.querySelectorAll(".home-module-resize").forEach((grip) => {
    const section = grip.closest(".home-module");
    if (!section) return;

    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const startY = event.clientY;
      const startHeight = section.getBoundingClientRect().height;
      section.classList.add("is-resizing");
      try { grip.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }

      const heightAt = (clientY) => Math.max(MIN_HEIGHT, Math.round(startHeight + (clientY - startY)));

      const onMove = (moveEvent) => {
        const next = heightAt(moveEvent.clientY);
        section.style.setProperty("--module-height", `${next}px`);
        section.classList.add("has-height");
      };

      const onUp = (upEvent) => {
        try { grip.releasePointerCapture(event.pointerId); } catch (_) { /* ignore */ }
        section.classList.remove("is-resizing");
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        setModuleHeight(section.dataset.module, heightAt(upEvent.clientY));
        renderHome();
      };

      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    });
  });
}

function setHomeDate(now) {  const dateEl = document.querySelector("#home-date");
  if (!dateEl) return;
  dateEl.textContent = capitalize(now.toLocaleDateString("ru-RU", {
    weekday: "long", day: "numeric", month: "long",
  }));
}

/** Обновляет только карточку расписания — не сбрасывает раскрытые блоки ДЗ. */
export function updateHomeLive() {
  const content = document.querySelector("#home-content");
  if (!content) return;

  setHomeDate(new Date());
  const card = content.querySelector('[data-module="schedule"] .today-schedule-card');
  if (!card) return;

  const wrapper = document.createElement("div");
  const fresh = scheduleCard(getScheduleNow());
  wrapper.innerHTML = editMode ? withDragHandle(fresh) : fresh;
  const next = wrapper.firstElementChild;
  if (next) card.replaceWith(next);
}

/** Подгружает сведения о сохранённой картинке (для модуля «Изображение»). */
export async function refreshImageInfo() {
  await loadImageInfo();
}
