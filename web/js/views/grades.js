import { escapeHtml, shortDate, markCls } from '../utils.js';
import { isNewMark, newMarksCount } from '../changes.js';

export function renderGrades(data) {
  const label = document.querySelector("#grades-sub");
  const term = escapeHtml(data.term || "Текущий период");
  const fresh = newMarksCount();
  label.innerHTML = `Отметки за период · ${term}` + (fresh ? ` · новых: ${fresh}` : "");

  const counts = data.counts || {};
  const summary = [
    `<span class="chip">Средний балл <b>${data.average != null ? String(data.average).replace(".", ",") : "—"}</b></span>`,
    `<span class="chip">Оценок <b>${data.marksCount || 0}</b></span>`,
  ];
  if (fresh) summary.push(`<span class="chip chip-new">Новых <b>${fresh}</b></span>`);
  ["5", "4", "3", "2"].forEach((v) => {
    if (counts[v]) summary.push(`<span class="chip">«${v}» <b>${counts[v]}</b></span>`);
  });

  const subjects = (data.subjects || []).filter((s) => s.marks.length);
  const list = document.querySelector("#grades-list");

  const errText = data.error || "";
  const errHtml = errText
    ? `<div class="banner" style="margin-bottom:12px;">${escapeHtml(errText)}</div>`
    : "";

  if (!subjects.length) {
    list.innerHTML = errHtml + `<div class="empty"><strong>Оценок пока нет</strong>За период ничего не выставлено.</div>`;
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

  list.innerHTML = errHtml + dotsHtml + `<div class="summary">${summary.join("")}</div>` +
    subjects.map((subj) => {
      const marksHtml = subj.marks.map((m) => {
        const w = m.weight > 1 ? `<span class="weight-badge">x${m.weight}</span>` : "";
        const isNew = isNewMark(subj.name, m);
        return `
          <span class="mark-chip ${markCls(m.value)} ${isNew ? "is-new" : ""}" ${isNew ? 'title="Новая оценка"' : ""}>
            ${escapeHtml(m.value)}
            <small>${escapeHtml(shortDate(m.date))}</small>
            ${w}
            ${isNew ? `<span class="new-dot"></span>` : ""}
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
  if (!list) return;

  results = results || {};
  const mode = results.mode === "year" ? "year" : "current";
  const subjects = (results.subjects || []).filter((s) => s.average != null);

  // Подпись над списком: выбранный режим и период.
  const sub = document.querySelector("#results-sub");
  if (sub) {
    const period = results.term ? ` · ${results.term}` : "";
    sub.textContent = mode === "year"
      ? `Годовые отметки${period}`
      : `Рейтинг предметов по среднему баллу${period}`;
  }

  // Сообщение об ошибке/предупреждении от бэкенда — показываем всегда сверху.
  const errText = results.error || results.warning || "";
  const errHtml = errText
    ? `<div class="banner" style="margin-bottom:12px;">${escapeHtml(errText)}</div>`
    : "";

  if (!subjects.length) {
    const hint = mode === "year"
      ? "Годовые оценки ещё не выставлены — выберите триместр или дождитесь конца учебного года."
      : "Средние баллы не рассчитаны.";
    list.innerHTML = errHtml + `<div class="empty"><strong>Пока пусто</strong>${hint}</div>`;
    return;
  }

  // Сортируем по убыванию балла
  subjects.sort((a, b) => b.average - a.average);

  // --- Вспомогательные ---
  const clampMark = (v) => Math.max(2, Math.min(5, Math.round(v)));
  const fmt = (v) => String(v).replace(".", ",").slice(0, 4);

  // Распределение по округлённым отметкам
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0 };
  subjects.forEach((s) => distribution[clampMark(s.average)]++);

  // ИСПРАВЛЕНИЕ: Всегда считаем средний балл сами на основе видимых предметов,
  // чтобы избежать расхождений с бэкендом СГО (когда предметов 18, а оценок 17).
  let commonAvg = subjects.reduce((sum, s) => sum + s.average, 0) / subjects.length;

  // Цвет и подпись для общего балла
  let avgColor = "#10b981";
  let avgLabel = "Отлично!";
  if (commonAvg < 4.5) { avgColor = "#3b82f6"; avgLabel = "Хорошо"; }
  if (commonAvg < 3.5) { avgColor = "#f59e0b"; avgLabel = "Средне"; }
  if (commonAvg < 2.5) { avgColor = "#ef4444"; avgLabel = "Слабо"; }

  // Круговой индикатор: диапазон 2..5 → 0..100%
  const r = 42;
  const C = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, (commonAvg - 2) / 3));
  const dashOffset = (C * (1 - pct)).toFixed(2);

  const summaryHtml = `
    <div class="results-summary">
      <div class="results-circle-wrap">
        <svg class="results-circle" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="results-circle-bg" cx="50" cy="50" r="${r}"
                  fill="none" stroke-width="10"/>
          <circle class="results-circle-fill" cx="50" cy="50" r="${r}"
                  fill="none" stroke-width="10"
                  stroke-linecap="round"
                  stroke-dasharray="${C.toFixed(2)}"
                  stroke-dashoffset="${dashOffset}"
                  transform="rotate(-90 50 50)"
                  style="stroke:${avgColor}"/>
        </svg>
        <div class="results-circle-inner">
          <div class="results-circle-value" style="color:${avgColor}">${fmt(commonAvg)}</div>
          <div class="results-circle-label">${avgLabel}</div>
        </div>
      </div>
      <div class="results-stats">
        <div class="results-stat">
          <span class="results-stat-value">${subjects.length}</span>
          <span class="results-stat-label">Предметов</span>
        </div>
        <div class="results-stat results-stat-good">
          <span class="results-stat-value">${distribution[5]}</span>
          <span class="results-stat-label">«5»</span>
        </div>
        <div class="results-stat results-stat-ok">
          <span class="results-stat-value">${distribution[4]}</span>
          <span class="results-stat-label">«4»</span>
        </div>
        <div class="results-stat results-stat-warn">
          <span class="results-stat-value">${distribution[3]}</span>
          <span class="results-stat-label">«3»</span>
        </div>
        ${distribution[2] > 0 ? `
          <div class="results-stat results-stat-bad">
            <span class="results-stat-value">${distribution[2]}</span>
            <span class="results-stat-label">«2»</span>
          </div>` : ""}
      </div>
    </div>
  `;

  const rows = subjects.map((s, index) => {
    const pctBar = Math.max(0, Math.min(100, (s.average / 5) * 100)).toFixed(1);
    const level = clampMark(s.average);

    let medal;
    if (index === 0) medal = `<span class="result-medal">🥇</span>`;
    else if (index === 1) medal = `<span class="result-medal">🥈</span>`;
    else if (index === 2) medal = `<span class="result-medal">🥉</span>`;
    else medal = `<span class="result-medal result-medal-num">${index + 1}</span>`;

    // В режиме «триместр» показываем подсказку с годовой, если она уже есть.
    let extra = "";
    if (mode === "current" && s.final != null) {
      extra = `<small class="result-note">годовая ${String(s.final).replace(".", ",")}</small>`;
    } else if (mode === "current" && s.marksCount) {
      extra = `<small class="result-note">${s.marksCount} оц.</small>`;
    }

    return `
      <div class="result-card">
        ${medal}
        <div class="result-main">
          <div class="result-name-row">
            <span class="result-name">${escapeHtml(s.name)}</span>
            <span class="result-score">${fmt(s.average)}</span>
          </div>
          <div class="result-bar">
            <div class="result-bar-fill level-${level}"
                 data-target="${pctBar}%" style="width:0%"></div>
          </div>
          ${extra ? `<div class="result-extra">${extra}</div>` : ""}
        </div>
      </div>
    `;
  }).join("");

  list.innerHTML = errHtml + summaryHtml + `<div class="results-grid">${rows}</div>`;

  // Плавное заполнение полосок с лёгкой задержкой
  requestAnimationFrame(() => {
    list.querySelectorAll(".result-bar-fill").forEach((el, i) => {
      const target = el.dataset.target;
      setTimeout(() => { el.style.width = target; }, 80 + Math.min(i, 15) * 45);
    });
  });
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