import { escapeHtml } from '../utils.js';

export function renderHomework(homework) {
  document.querySelector("#hw-label").textContent = homework.label + (homework.isTomorrow ? " · завтра" : "");
  const note = document.querySelector("#hw-note");
  if (homework.note) { note.textContent = homework.note; note.hidden = false; }
  else { note.hidden = true; }

  const list = document.querySelector("#hw-list");
  if (!homework.lessons.length) {
    list.innerHTML = `<div class="empty"><strong>Уроков нет</strong>На этот день нет расписания.</div>`;
    return;
  }
  list.innerHTML = homework.lessons.map((lesson) => {
    const time = lesson.start ? `${lesson.start}${lesson.end ? "–" + lesson.end : ""}` : "";
    const meta = [time, lesson.room ? `каб. ${lesson.room}` : ""].filter(Boolean).join(" · ");
    const tasks = lesson.tasks.length
      ? `<ul class="tasks">${lesson.tasks.map((task) => {
          const details = (task.details || []).map((d) => {
            const label = task.details_label ? `<b>${escapeHtml(task.details_label)}:</b> ` : "";
            return `<p class="task-detail">${label}${escapeHtml(d)}</p>`;
          }).join("");
          const files = (task.files || []).length
            ? `<div class="files">${task.files.map((f) => `<span class="file">📎 ${escapeHtml(f)}</span>`).join("")}</div>`
            : "";
          const type = task.type ? `<span class="file">${escapeHtml(task.type)}</span>` : "";
          return `<li>
            ${task.text ? `<p class="task-text">${escapeHtml(task.text)}</p>` : ""}
            ${details}
            ${files || type ? `<div class="files">${type}${files}</div>` : ""}
          </li>`;
        }).join("")}</ul>`
      : `<p class="meta">Задания нет</p>`;
    return `<article class="card">
      <div class="card-head">
        <span class="num">${escapeHtml(lesson.number ?? "")}</span>
        <div>
          <h3>${escapeHtml(lesson.subject)}</h3>
          ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
        </div>
      </div>
      ${tasks}
    </article>`;
  }).join("");
}