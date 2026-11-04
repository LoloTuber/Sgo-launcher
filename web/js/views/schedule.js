import { state } from '../state.js';
import {
  BELLS_40_MON, BELLS_30_MON, BELLS_40_OTH, BELLS_30_OTH,
  escapeHtml, shortDate, getTimeInMinutes
} from '../utils.js';

// Получаем сохраненные заметки из памяти браузера
function getNotes() {
  try {
    return JSON.parse(localStorage.getItem("sgo.scheduleNotes")) || {};
  } catch { return {}; }
}

function saveNote(date, text) {
  const notes = getNotes();
  if (text) {
    notes[date] = text;
  } else {
    delete notes[date];
  }
  localStorage.setItem("sgo.scheduleNotes", JSON.stringify(notes));
  renderScheduleData(state.schedule);
  updateScheduleStatus();
}

export function renderScheduleData(data) {
  const list = document.querySelector("#schedule-content");
  if (!data.days || !data.days.length) {
    list.innerHTML = `<div class="empty"><strong>Нет уроков</strong>На эту неделю расписания нет.</div>`;
    return;
  }

  const notes = getNotes();

  list.innerHTML = `
    <div class="schedule-grid">
      ${data.days.map(day => {
        if (!day.lessons.length && !notes[day.date]) return "";
        
        const isMonday = day.weekday.toLowerCase() === "понедельник";
        let lessons = JSON.parse(JSON.stringify(day.lessons || []));
        
        if (isMonday) {
          if (!lessons.some(l => l.number === 0)) {
            lessons.push({ number: 0, subject: "Разговоры о важном" });
          }
          const idx = lessons.findIndex(l => l.number === 9 && l.subject.includes("Разговор"));
          if (idx !== -1) lessons.splice(idx, 1);
        }

        lessons.sort((a, b) => a.number - b.number);

        const bells = state.isShortDay
          ? (isMonday ? BELLS_30_MON : BELLS_30_OTH)
          : (isMonday ? BELLS_40_MON : BELLS_40_OTH);

        const note = notes[day.date] || "";
        let displayNote = note;
        
        // Разбираем заметку (например, "3" или "3-5")
        const rangeMatch = note.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]);
          const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : null;
          const bellStart = bells[start];
          
          if (end) {
            displayNote = `📍 Уроки с ${start}-го по ${end}-й`;
          } else if (bellStart) {
            displayNote = `📍 Прийти к ${start}-му уроку (${bellStart[0]})`;
          } else {
            displayNote = `📍 Прийти к ${start}-му уроку`;
          }
        }

        return `
          <div class="schedule-day">
            <div class="schedule-day-title" style="display:flex; justify-content:space-between; align-items:center;">
              <span>${day.weekday}, ${shortDate(day.date)}</span>
              <button class="btn-edit-note" data-date="${day.date}" style="background:none; border:none; cursor:pointer; font-size:16px; padding:4px;" title="Изменить расписание">✏️</button>
            </div>
            ${displayNote ? `<div style="background:var(--green-100); color:var(--green-800); padding:8px 16px; font-weight:600; border-bottom:1px solid var(--line); font-size:14px;">${escapeHtml(displayNote)}</div>` : ""}
            <div class="schedule-lessons">
              ${lessons.map(l => {
                let timeStr = "";
                const bell = bells[l.number];
                
                if (bell) {
                  timeStr = `${bell[0]}–${bell[1]}`;
                } else {
                  timeStr = `${l.start}–${l.end}`; 
                }

                const isZero = l.number === 0;

                return `
                  <div class="schedule-item ${isZero ? 'sch-zero' : ''}">
                    <div class="sch-num">${l.number}</div>
                    <div class="sch-subject">${escapeHtml(l.subject)}</div>
                    <div class="sch-time">${timeStr}</div>
                  </div>
                `;
              }).join("")}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;

  // Обработчик кнопки редактирования
  document.querySelectorAll(".btn-edit-note").forEach(btn => {
    btn.addEventListener("click", () => {
      const date = btn.dataset.date;
      const currentNote = getNotes()[date] || "";
      const newNote = prompt("К какому уроку прийти? (Введите номер, например 3, или диапазон 3-5):", currentNote);
      if (newNote !== null) {
        saveNote(date, newNote.trim());
      }
    });
  });

  updateScheduleStatus();
}

export function updateScheduleStatus() {
  const statusEl = document.querySelector("#schedule-status");
  if (!statusEl || !state.schedule) return;

  const now = new Date();
  const currentMin = now.getHours() * 60 + now.getMinutes();
  const dayOfWeek = now.getDay();

  if (dayOfWeek === 0) {
    statusEl.innerHTML = "Сегодня воскресенье. Уроков нет.";
    statusEl.classList.add("finished");
    statusEl.hidden = false;
    return;
  }

  const tzOffset = now.getTimezoneOffset() * 60000;
  const localISOTime = (new Date(now - tzOffset)).toISOString().slice(0, 10);
  
  const notes = getNotes();
  const todayData = state.schedule.days.find(d => d.date === localISOTime);
  const todayNote = notes[localISOTime] || "";
  
  if ((!todayData || !todayData.lessons.length) && !todayNote) {
    statusEl.innerHTML = "На сегодня уроков нет.";
    statusEl.classList.add("finished");
    statusEl.hidden = false;
    return;
  }

  const isMonday = dayOfWeek === 1;
  const bells = state.isShortDay
    ? (isMonday ? BELLS_30_MON : BELLS_30_OTH)
    : (isMonday ? BELLS_40_MON : BELLS_40_OTH);

  let firstLesson = isMonday ? 0 : 1;
  let lastLesson = todayData && todayData.lessons.length 
    ? Math.max(...todayData.lessons.map(l => l.number)) 
    : 9;
  
  // Если есть заметка с номером или диапазоном, применяем её
  const rangeMatch = todayNote.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
  if (rangeMatch) {
    firstLesson = parseInt(rangeMatch[1]);
    if (rangeMatch[2]) {
      lastLesson = parseInt(rangeMatch[2]);
    }
  }

  const firstBell = bells[firstLesson] || ["08:00", "08:40"];
  const firstStart = getTimeInMinutes(firstBell[0]);

  const lastBell = bells[lastLesson] || (isMonday ? ["14:55", "15:15"] : ["14:40", "15:20"]);
  const lastEnd = getTimeInMinutes(lastBell[1]);

  statusEl.hidden = false;

  if (currentMin < firstStart) {
    statusEl.classList.remove("finished");
    const diff = firstStart - currentMin;
    const h = Math.floor(diff / 60);
    const m = diff % 60;
    let timeStr = "";
    if (h > 0) timeStr += `${h} ч `;
    if (m > 0 || h === 0) timeStr += `${m} мин`;
    statusEl.innerHTML = `⏳ До ${firstLesson === 0 ? 'начала' : firstLesson + '-го урока'} осталось: <b>${timeStr}</b>`;
  } else if (currentMin > lastEnd) {
    statusEl.classList.add("finished");
    statusEl.innerHTML = "🏁 Уроки на сегодня прошли";
  } else {
    statusEl.classList.remove("finished");
    let currentLesson = null;
    for (let i = firstLesson; i <= lastLesson; i++) {
      if (bells[i]) {
        const start = getTimeInMinutes(bells[i][0]);
        const end = getTimeInMinutes(bells[i][1]);
        if (currentMin >= start && currentMin <= end) {
          currentLesson = i;
          break;
        }
      }
    }
    if (currentLesson !== null) {
      statusEl.innerHTML = `📖 Идёт ${currentLesson}-й урок`;
    } else {
      statusEl.innerHTML = `☕ Перемена`;
    }
  }
}