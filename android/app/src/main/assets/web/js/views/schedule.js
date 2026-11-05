import { state } from '../state.js';
import { getSettings } from '../settings.js';
import { isDayChanged } from '../changes.js';
import {
  BELLS_40_MON, BELLS_30_MON, BELLS_40_OTH, BELLS_30_OTH,
  escapeHtml, shortDate, getTimeInMinutes, localIsoDate, isImportantTalkSubject
} from '../utils.js';

const WEEKDAYS = [
  "Воскресенье", "Понедельник", "Вторник", "Среда",
  "Четверг", "Пятница", "Суббота",
];

// Заметки к расписанию (к какому уроку прийти) храним в браузере.
function getNotes() {
  try {
    const parsed = JSON.parse(localStorage.getItem("sgo.scheduleNotes") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveNote(date, text) {
  const notes = getNotes();
  if (text) {
    notes[date] = text;
  } else {
    delete notes[date];
  }
  try {
    localStorage.setItem("sgo.scheduleNotes", JSON.stringify(notes));
  } catch (_) { /* localStorage может быть недоступен */ }
  if (state.schedule) renderScheduleData(state.schedule);
}

function bellsFor(isMonday) {
  if (state.isShortDay) return isMonday ? BELLS_30_MON : BELLS_30_OTH;
  return isMonday ? BELLS_40_MON : BELLS_40_OTH;
}

/**
 * Готовит день к показу: добавляет «Разговоры о важном» в понедельник,
 * убирает их из остальных дней, сортирует уроки и подставляет время звонков.
 */
function isImportantTalk(lesson) {
  return isImportantTalkSubject(lesson && lesson.subject);
}

function prepareDay(day) {
  if (!day) return null;

  const isMonday = String(day.weekday || "").toLowerCase() === "понедельник";
  let lessons = JSON.parse(JSON.stringify(day.lessons || []));

  if (isMonday) {
    if (!lessons.some((lesson) => lesson.number === 0 || isImportantTalk(lesson))) {
      lessons.push({ number: 0, subject: "Разговоры о важном" });
    }
    const zeroIndex = lessons.findIndex(
      (lesson) => lesson.number === 9 && isImportantTalk(lesson)
    );
    if (zeroIndex !== -1) lessons.splice(zeroIndex, 1);
  } else {
    // По правилам «Разговоры о важном» бывают только в понедельник.
    lessons = lessons.filter((lesson) => !isImportantTalk(lesson));
  }

  lessons.sort((a, b) => a.number - b.number);

  const bells = bellsFor(isMonday);
  for (const lesson of lessons) {
    const bell = bells[lesson.number];
    const start = bell ? bell[0] : lesson.start;
    const end = bell ? bell[1] : lesson.end;
    lesson.timeLabel = start && end ? `${start}–${end}` : (start || "");
    lesson.startMin = start ? getTimeInMinutes(start) : null;
    lesson.endMin = end ? getTimeInMinutes(end) : null;
  }

  return { ...day, isMonday, lessons, bells };
}

export function formatLeft(minutes) {
  const total = Math.max(0, Math.round(minutes));
  if (total <= 0) return "меньше минуты";
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours && mins) return `${hours} ч ${mins} мин`;
  if (hours) return `${hours} ч`;
  return `${mins} мин`;
}

/**
 * Структурированное состояние расписания на сейчас.
 * Используется и вкладкой «Расписание», и экраном «Сегодня».
 */
export function getScheduleNow(now = new Date()) {
  const todayIso = localIsoDate(now);
  const currentMin = now.getHours() * 60 + now.getMinutes();
  const dayOfWeek = now.getDay();

  const info = {
    date: todayIso,
    weekday: WEEKDAYS[dayOfWeek],
    status: "no-data",
    tone: "finished",
    html: "",
    day: null,
    lessons: [],
    current: null,
    next: null,
    minutesLeft: 0,
    note: "",
  };

  if (dayOfWeek === 0) {
    info.status = "sunday";
    info.html = "Сегодня воскресенье. Уроков нет.";
    return info;
  }

  const notes = getNotes();
  const note = notes[todayIso] || "";
  info.note = note;

  const schedule = state.schedule;
  const rawDay = schedule && Array.isArray(schedule.days)
    ? schedule.days.find((day) => day.date === todayIso)
    : null;
  const day = prepareDay(rawDay || {
    date: todayIso,
    weekday: WEEKDAYS[dayOfWeek],
    lessons: [],
  });

  if (!day) return info;
  info.day = day;
  info.lessons = day.lessons;

  if (!day.lessons.length && !note) {
    info.status = "no-lessons";
    info.html = "На сегодня уроков нет.";
    return info;
  }

  const numbers = day.lessons.map((lesson) => lesson.number);
  let firstLesson = day.isMonday ? 0 : 1;
  let lastLesson = 9;

  if (numbers.length) {
    firstLesson = day.isMonday ? Math.min(0, ...numbers) : Math.min(...numbers);
    lastLesson = Math.max(...numbers);
  }

  // Заметка «прийти к N-му» или диапазон сдвигает границы дня.
  const rangeMatch = note.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
  let hasRange = false;
  if (rangeMatch) {
    hasRange = true;
    firstLesson = parseInt(rangeMatch[1], 10);
    if (rangeMatch[2]) lastLesson = parseInt(rangeMatch[2], 10);
  }

  const firstBell = day.bells[firstLesson] || ["08:00", "08:40"];
  const firstStart = getTimeInMinutes(firstBell[0]);
  const lastBell = day.bells[lastLesson] || (day.isMonday ? ["14:55", "15:15"] : ["14:40", "15:20"]);
  const lastEnd = getTimeInMinutes(lastBell[1]);

  const relevant = hasRange
    ? day.lessons.filter((lesson) => lesson.number >= firstLesson && lesson.number <= lastLesson)
    : day.lessons;

  // Состояние каждого урока: прошёл / идёт / следующий.
  let nextLesson = null;
  for (const lesson of relevant) {
    if (lesson.startMin == null || lesson.endMin == null) {
      lesson.state = "";
      continue;
    }
    if (currentMin >= lesson.endMin) {
      lesson.state = "past";
    } else if (currentMin >= lesson.startMin && currentMin < lesson.endMin) {
      lesson.state = "current";
      info.current = lesson;
    } else if (!nextLesson) {
      lesson.state = "next";
      nextLesson = lesson;
    } else {
      lesson.state = "upcoming";
    }
  }
  info.next = nextLesson;

  info.tone = "active";

  if (currentMin < firstStart) {
    info.status = "before";
    info.minutesLeft = firstStart - currentMin;
    const label = firstLesson === 0 ? "начала" : `${firstLesson}-го урока`;
    info.html = `⏳ До ${label} осталось: <b>${formatLeft(info.minutesLeft)}</b>`;
    if (!info.next) {
      info.next = relevant.find((lesson) => lesson.number === firstLesson) || null;
    }
    return info;
  }

  if (currentMin > lastEnd) {
    info.status = "finished";
    info.tone = "finished";
    info.html = "🏁 Уроки на сегодня прошли";
    return info;
  }

  if (info.current) {
    info.status = "lesson";
    info.minutesLeft = info.current.endMin - currentMin;
    info.html = `📖 Идёт ${info.current.number}-й урок · до конца <b>${formatLeft(info.minutesLeft)}</b>`;
    return info;
  }

  if (info.next) {
    info.status = "break";
    info.minutesLeft = info.next.startMin - currentMin;
    info.html = `☕ Перемена · до звонка <b>${formatLeft(info.minutesLeft)}</b>`;
    return info;
  }

  info.status = "finished";
  info.tone = "finished";
  info.html = "🏁 Уроки на сегодня прошли";
  return info;
}

function clearHighlights() {
  document.querySelectorAll(".schedule-item.is-current, .schedule-item.is-next").forEach((el) => {
    el.classList.remove("is-current", "is-next");
  });
  document.querySelectorAll(".sch-left").forEach((el) => {
    el.hidden = true;
    el.textContent = "";
  });
}

function markLesson(date, number, kind, text) {
  const item = document.querySelector(
    `.schedule-item[data-date="${date}"][data-lesson="${number}"]`
  );
  if (!item) return;
  item.classList.add(kind);
  const left = item.querySelector(".sch-left");
  if (left) {
    left.textContent = text;
    left.hidden = false;
  }
}

function renderNote(note, bells) {
  if (!note) return "";
  const rangeMatch = note.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
  if (!rangeMatch) return note;

  const start = parseInt(rangeMatch[1], 10);
  const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : null;
  if (end) return `📍 Уроки с ${start}-го по ${end}-й`;

  const bellStart = bells[start];
  if (bellStart) return `📍 Прийти к ${start}-му уроку (${bellStart[0]})`;
  return `📍 Прийти к ${start}-му уроку`;
}

export function renderScheduleData(data) {
  const list = document.querySelector("#schedule-content");
  if (!list) return;

  const settings = getSettings();
  const todayIso = localIsoDate();
  const notes = getNotes();

  let days = Array.isArray(data.days) ? data.days : [];

  if (settings.todayOnly) {
    days = days.filter((day) => day.date === todayIso);
  }

  if (!days.length) {
    const message = settings.todayOnly
      ? "Сегодня уроков нет — по настройкам показывается только текущий день."
      : "На эту неделю расписания нет.";
    list.innerHTML = `<div class="empty"><strong>Нет уроков</strong>${message}</div>`;
    updateScheduleStatus();
    return;
  }

  list.innerHTML = `
    ${settings.todayOnly ? `<div class="schedule-filter-note">Показан только сегодняшний день</div>` : ""}
    <div class="schedule-grid">
      ${days.map((rawDay) => {
        const day = prepareDay(rawDay);
        if (!day) return "";

        let lessons = day.lessons;
        if (settings.hideEmptyLessons) {
          lessons = lessons.filter((lesson) => String(lesson.subject || "").trim());
        }

        const note = notes[day.date] || "";
        if (!lessons.length && !note) return "";

        const changed = isDayChanged(day.date);
        const displayNote = renderNote(note, day.bells);

        return `
          <div class="schedule-day ${changed ? "is-changed" : ""} ${day.date === todayIso ? "is-today" : ""}">
            <div class="schedule-day-title">
              <span>${escapeHtml(day.weekday)}, ${shortDate(day.date)}</span>
              <span class="schedule-day-actions">
                ${changed ? `<span class="changed-badge">изменилось</span>` : ""}
                <button class="btn-edit-note" data-date="${day.date}" title="Изменить расписание">✏️</button>
              </span>
            </div>
            ${displayNote ? `<div class="schedule-note">${escapeHtml(displayNote)}</div>` : ""}
            <div class="schedule-lessons">
              ${lessons.map((lesson) => `
                  <div class="schedule-item ${lesson.number === 0 ? "sch-zero" : ""}"
                       data-date="${day.date}" data-lesson="${lesson.number}">
                    <div class="sch-num">${lesson.number}</div>
                    <div class="sch-subject">${escapeHtml(lesson.subject || "—")}</div>
                    <div class="sch-time">
                      <span>${escapeHtml(lesson.timeLabel)}</span>
                      <span class="sch-left" hidden></span>
                    </div>
                  </div>
                `).join("")}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;

  list.querySelectorAll(".btn-edit-note").forEach((btn) => {
    btn.addEventListener("click", () => {
      const date = btn.dataset.date;
      const currentNote = getNotes()[date] || "";
      const newNote = prompt(
        "К какому уроку прийти? (Введите номер, например 3, или диапазон 3-5):",
        currentNote
      );
      if (newNote !== null) saveNote(date, newNote.trim());
    });
  });

  updateScheduleStatus();
}

export function updateScheduleStatus() {
  const statusEl = document.querySelector("#schedule-status");
  if (!statusEl || !state.schedule) return;

  clearHighlights();

  const info = getScheduleNow();
  if (info.status === "no-data") {
    statusEl.hidden = true;
    return;
  }

  statusEl.hidden = false;
  statusEl.classList.toggle("finished", info.tone === "finished");
  statusEl.innerHTML = info.html;

  if (info.status === "lesson" && info.current) {
    markLesson(info.date, info.current.number, "is-current", `ещё ${formatLeft(info.minutesLeft)}`);
  } else if ((info.status === "before" || info.status === "break") && info.next) {
    markLesson(info.date, info.next.number, "is-next", `через ${formatLeft(info.minutesLeft)}`);
  }
}
