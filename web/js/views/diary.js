import * as api from '../api.js';
import { escapeHtml, shortDate, markCls } from '../utils.js';

export function renderDiary(data) {
  const list = document.querySelector("#diary-list");
  if (!data.days || !data.days.length) {
    list.innerHTML = `<div class="empty"><strong>Нет данных</strong>За эту неделю дневник пуст.</div>`;
    return;
  }
  
  document.querySelector("#diary-label").textContent = `Неделя ${shortDate(data.weekStart)} – ${shortDate(data.weekEnd)}`;
  
  list.innerHTML = data.days.map(day => {
    const lessons = day.lessons || [];
    if (!lessons.length) {
      return `
        <div class="diary-day">
          <div class="day-header">${day.weekday}, ${shortDate(day.date)}</div>
          <div class="day-body" style="color:var(--ink-soft);font-style:italic;">Уроков нет</div>
        </div>
      `;
    }
    
    return `
      <div class="diary-day">
        <div class="day-header">${day.weekday}, ${shortDate(day.date)}</div>
        <div class="day-body">
          ${lessons.map(l => {
            const markIds = new Set((l.marks || []).map(m => String(m.id)));
            const uniqueTasks = (l.tasks || []).filter(t => !markIds.has(String(t.id)));

            const marksHtml = (l.marks || []).length ? `
              <div class="dl-marks">
                ${l.marks.map(m => {
                  const w = m.weight > 1 ? `<span class="weight-badge">x${m.weight}</span>` : "";
                  return `
                  <div class="mark-wrapper">
                    <div class="mark-row" data-id="${escapeHtml(m.id)}">
                      <span class="mark-value ${markCls(m.value)}">${escapeHtml(m.value)}</span>
                      <div class="mark-info">
                        <div class="mark-topic">${escapeHtml(m.topic || "Без темы")} ${w}</div>
                        <div class="mark-meta">${escapeHtml(m.type || "Оценка")}</div>
                      </div>
                      <span class="mark-toggle">›</span>
                    </div>
                    <div class="mark-details" data-details-for="${escapeHtml(m.id)}"></div>
                  </div>
                `}).join("")}
              </div>
            ` : "";

            const tasksHtml = uniqueTasks.length ? `
              <div class="dl-hw">
                <div class="hw-title">Домашнее задание</div>
                <ul class="hw-list">
                  ${uniqueTasks.map(t => `<li>${escapeHtml(t.text)}</li>`).join("")}
                </ul>
              </div>
            ` : "";

            return `
              <div class="diary-lesson">
                <div class="dl-head">
                  <span class="dl-num">${l.number}</span>
                  <span class="dl-subj">${escapeHtml(l.subject)}</span>
                  <span class="dl-time">${l.start}–${l.end}</span>
                </div>
                <div class="dl-content">
                  ${marksHtml}
                  ${tasksHtml}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }).join("");
  
  document.querySelectorAll(".mark-row").forEach(row => {
    row.addEventListener("click", () => toggleMark(row));
  });
}

async function toggleMark(row) {
  const id = row.dataset.id;
  if (!id) return;
  const details = document.querySelector(`[data-details-for="${id}"]`);
  if (!details) return;

  if (row.classList.contains("open")) {
    row.classList.remove("open");
    details.innerHTML = "";
    return;
  }
  if (row.classList.contains("loading")) return;

  row.classList.add("loading");
  try {
    const data = await api.getAssignmentDetails(id);
    const parts = [];
    if (data.teachers && data.teachers.length) {
      parts.push(`<p><span class="label">Учитель:</span> ${escapeHtml(data.teachers.join(", "))}</p>`);
    }
    (data.details || []).forEach((d) => {
      parts.push(`<p><span class="label">Комментарий:</span> ${escapeHtml(d)}</p>`);
    });
    if (data.files && data.files.length) {
      parts.push(
        `<div class="files">${data.files.map((f) => `<span class="file">📎 ${escapeHtml(f)}</span>`).join("")}</div>`
      );
    }
    if (!parts.length) parts.push(`<p class="meta">Дополнительных сведений нет.</p>`);
    details.innerHTML = parts.join("");
    row.classList.add("open");
  } catch (e) {
    details.innerHTML = `<p style="color:var(--red)">Не удалось загрузить: ${escapeHtml(e.message)}</p>`;
    row.classList.add("open");
  } finally {
    row.classList.remove("loading");
  }
}