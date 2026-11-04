import { escapeHtml, shortDate, markCls } from '../utils.js';

export function renderGrades(data) {
  const label = document.querySelector("#grades-sub");
  const term = escapeHtml(data.term || "Текущий период");
  label.innerHTML = `Отметки за период · ${term}`;

  const counts = data.counts || {};
  const summary = [
    `<span class="chip">Средний балл <b>${data.average != null ? String(data.average).replace(".", ",") : "—"}</b></span>`,
    `<span class="chip">Оценок <b>${data.marksCount || 0}</b></span>`,
  ];
  ["5", "4", "3", "2"].forEach((v) => {
    if (counts[v]) summary.push(`<span class="chip">«${v}» <b>${counts[v]}</b></span>`);
  });

  const subjects = (data.subjects || []).filter((s) => s.marks.length);
  const list = document.querySelector("#grades-list");
  
  if (!subjects.length) {
    list.innerHTML = `<div class="empty"><strong>Оценок пока нет</strong>За период ничего не выставлено.</div>`;
    return;
  }

  // Ищем текущие точки (долги)
  const dots = [];
  subjects.forEach(subj => {
    subj.marks.forEach(m => {
      if (m.value === "." || m.value === "-") {
        dots.push({
          subject: subj.name,
          date: m.date,
          topic: m.topic || "Без темы"
        });
      }
    });
  });

  let dotsHtml = "";
  if (dots.length > 0) {
    // Сортируем точки по дате (сначала новые)
    dots.sort((a, b) => (a.date < b.date ? 1 : -1));
    
    dotsHtml = `
      <div class="calc-card" style="border-color: var(--red); background: #fff5f5; margin-bottom: 20px;">
        <div class="calc-title" style="color: var(--red); border-bottom-color: #fde8e7;">
          ⚠️ Текущие точки (требуют исправления)
        </div>
        <div class="calc-list">
          ${dots.map(d => `
            <div class="calc-row" style="background: transparent; border-bottom: 1px dashed #fde8e7; border-radius: 0; padding: 10px 0;">
              <span class="mark-value m0" style="min-width: 30px; height: 30px; font-size: 20px;">.</span>
              <div class="calc-row-info">
                <div class="calc-row-topic">${escapeHtml(d.subject)}</div>
                <div class="calc-row-meta">${escapeHtml(shortDate(d.date))} · ${escapeHtml(d.topic)}</div>
              </div>
            </div>
          `).join("")}
        </div>
        <p style="font-size:12px;color:var(--red);margin-top:12px;opacity:0.8;">* Эти оценки не учитываются в среднем балле, но их нужно исправить.</p>
      </div>
    `;
  }

  list.innerHTML = dotsHtml + `<div class="summary">${summary.join("")}</div>` +
    subjects.map((subj) => {
      const marksHtml = subj.marks.map((m) => {
        const w = m.weight > 1 ? `<span class="weight-badge">x${m.weight}</span>` : "";
        return `
          <span class="mark-chip ${markCls(m.value)}">
            ${escapeHtml(m.value)}
            <small>${escapeHtml(shortDate(m.date))}</small>
            ${w}
          </span>
        `;
      }).join("");

      const avg = subj.average != null
        ? `<span class="badge">${String(subj.average).replace(".", ",")}</span>` : "";
      return `<article class="subject">
        <div class="subject-head">
          <h3>${escapeHtml(subj.name)}</h3>
          ${avg}
        </div>
        <div class="marks">${marksHtml}</div>
      </article>`;
    }).join("");
}

export function renderResults(results) {
  const list = document.querySelector("#results-list");
  const subjects = (results.subjects || []).filter((s) => s.average != null);
  
  if (!subjects.length) {
    list.innerHTML = `<div class="empty"><strong>Пока пусто</strong>Средние баллы не рассчитаны.</div>`;
    return;
  }

  // Сортируем по убыванию среднего балла
  subjects.sort((a, b) => b.average - a.average);

  const common = results.common != null
    ? `<div class="summary">
         <span class="chip">Общий средний балл <b>${String(results.common).replace(".", ",")}</b></span>
         <span class="chip">Предметов <b>${subjects.length}</b></span>
       </div>`
    : "";

  list.innerHTML = common + subjects.map((s, index) => {
    let medal = "";
    if (index === 0) medal = `<span class="rank-badge rank-1">1</span>`;
    else if (index === 1) medal = `<span class="rank-badge rank-2">2</span>`;
    else if (index === 2) medal = `<span class="rank-badge rank-3">3</span>`;
    else medal = `<span class="rank-badge" style="background:var(--green-100); color:var(--green-800);">${index + 1}</span>`;

    return `
      <div class="result-row">
        <span class="name" style="display:flex; align-items:center;">
          ${medal} ${escapeHtml(s.name)}
        </span>
        <span class="value">${String(s.average).replace(".", ",")}</span>
      </div>`;
  }).join("");
}

export function renderAttendance(data) {
  const att = data.attendance || { items: [], counts: {} };
  const label = document.querySelector("#att-sub");
  const term = escapeHtml(data.term || "Текущий период");
  label.innerHTML = `${term}${data.asOf ? ` · данные на ${escapeHtml(data.asOf)}` : ""}`;

  const list = document.querySelector("#att-list");
  const items = att.items || [];
  if (!items.length) {
    list.innerHTML = `<div class="empty"><strong>Пропусков нет</strong>Посещаемость без замечаний.</div>`;
    return;
  }
  const counts = att.counts || {};
  const names = Object.keys(counts).filter((c) => c !== "__total");
  const summary = [`<span class="chip">Всего <b>${att.total || 0}</b></span>`]
    .concat(names.map((c) => `<span class="chip">${escapeHtml(c)} <b>${counts[c]}</b></span>`));

  const rows = items.map((it) => `
    <div class="att-item">
      <span class="att-code ${it.counted ? "" : "ok"}">${escapeHtml(it.code)}</span>
      <div class="att-body">
        <div class="date">${escapeHtml(shortDate(it.date))} · ${escapeHtml(it.label)}</div>
        <div class="subject">${escapeHtml(it.subject)}</div>
      </div>
    </div>`).join("");
  list.innerHTML = `<div class="summary">${summary.join("")}</div>` + rows;
}