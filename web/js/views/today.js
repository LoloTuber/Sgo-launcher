import { state } from '../state.js';
import {
  escapeHtml, shortDate, markCls, localIsoDate, addDaysIso, capitalize, toast,
  isImportantTalkSubject, formatAverage,
} from '../utils.js';
import {
  getScheduleNow, getNextSchoolDay, editScheduleNote, formatScheduleNote, formatLeft,
} from './schedule.js';
import { subjectAverage } from '../weights.js';
import {
  isNewMark, isNewHomework, isDayChanged, markAllRead,
  newMarksCount, newHomeworkCount, changedDaysCount,
} from '../changes.js';

/**
 * Экран «Сегодня»: расписание на сейчас, домашнее задание,
 * последние оценки и то, что требует внимания.
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

function taskWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "задание";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "задания";
  return "заданий";
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

export function renderToday() {
  const content = document.querySelector("#today-content");
  if (!content) return;

  const now = new Date();
  setTodayDate(now);
  const info = getScheduleNow(now);
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

  content.innerHTML = `
    ${freshHtml}
    ${scheduleCard(info)}
    ${homeworkCard()}
    ${latestGradesCard()}
    ${attentionCard()}
    <div class="today-actions">
      ${goButton("diary", "Дневник")}
      ${goButton("schedule", "Расписание")}
      ${goButton("grades", "Успеваемость")}
      ${goButton("calc", "Калькулятор")}
    </div>
  `;

  // Делегирование: карточка расписания может обновляться отдельно от экрана.
  content.onclick = (event) => {
    const readAll = event.target.closest("[data-action='mark-read']");
    if (readAll && content.contains(readAll)) {
      markAllRead();
      renderToday();
      toast("Отмечено прочитанным");
      window.dispatchEvent(new CustomEvent("sgo:changes-read"));
      return;
    }

    const editNote = event.target.closest("[data-edit-note]");
    if (editNote && content.contains(editNote)) {
      if (editScheduleNote(editNote.dataset.editNote)) renderToday();
      return;
    }

    const button = event.target.closest("[data-go]");
    if (button && content.contains(button)) navigate(button.dataset.go);
  };
}

function setTodayDate(now) {
  const dateEl = document.querySelector("#today-date");
  if (!dateEl) return;
  dateEl.textContent = capitalize(now.toLocaleDateString("ru-RU", {
    weekday: "long", day: "numeric", month: "long",
  }));
}

/** Обновляет только карточку расписания — не сбрасывает раскрытые блоки ДЗ. */
export function updateTodayLive() {
  const content = document.querySelector("#today-content");
  if (!content) return;

  setTodayDate(new Date());
  const card = content.querySelector(".today-schedule-card");
  if (!card) return;

  const wrapper = document.createElement("div");
  wrapper.innerHTML = scheduleCard(getScheduleNow());
  const next = wrapper.firstElementChild;
  if (next) card.replaceWith(next);
}
