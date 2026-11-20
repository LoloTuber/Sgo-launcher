import { escapeHtml, shortDate, markCls, formatAverage } from '../utils.js';
import { isNewMark, newMarksCount } from '../changes.js';
import { loadDetails, renderAssignmentDetails } from './details.js';
import { userError } from '../errors.js';

export function renderGrades(data) {
  const label = document.querySelector("#grades-sub");
  const term = escapeHtml(data.term || "Текущий период");
  const fresh = newMarksCount();
  label.innerHTML = `Отметки за период · ${term}` + (fresh ? ` · новых: ${fresh}` : "");

  const counts = data.counts || {};
  const summary = [
    `<span class="chip" title="Считается с учётом весов оценок (10/15/20/30), долг — как «2»">Средний балл <b>${formatAverage(data.average)}</b></span>`,
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
        <p style="font-size:12px;color:var(--red);margin-top:12px;opacity:0.8;">* Долг учитывается в среднем балле как «2» (с весом задания), но его нужно исправить.</p>
      </div>
    `;
  }

  list.innerHTML = errHtml + dotsHtml + `<div class="summary">${summary.join("")}</div>` +
    subjects.map((subj) => {
      const marksHtml = subj.marks.map((m) => {
        const w = m.weight > 1 ? `<span class="weight-badge">x${m.weight}</span>` : "";
        const isNew = isNewMark(subj.name, m);
        // Оценка кликабельна, если СГО дал идентификатор задания:
        // по нему открываются подробности (тема, вес, учитель, класс).
        const hasId = m.id !== undefined && m.id !== null && m.id !== 0 && m.id !== "";
        const title = [m.topic, m.type].filter(Boolean).join(" · ") || "Оценка";
        const attrs = hasId
          ? `data-mark-id="${escapeHtml(m.id)}" data-mark-value="${escapeHtml(m.value)}" data-mark-date="${escapeHtml(shortDate(m.date))}" role="button" tabindex="0" aria-expanded="false"`
          : "";
        return `
          <span class="mark-chip-wrap">
            <span class="mark-chip ${markCls(m.value)} ${isNew ? "is-new" : ""} ${hasId ? "is-clickable" : ""}"
                  ${attrs} title="${escapeHtml(title)}">
              ${escapeHtml(m.value)}
              <small>${escapeHtml(shortDate(m.date))}</small>
              ${w}
              ${isNew ? `<span class="new-dot"></span>` : ""}
              ${hasId ? `<span class="hw-chevron" aria-hidden="true">›</span>` : ""}
            </span>
          </span>
        `;
      }).join("");

      const avg = subj.average != null
        ? `<span class="badge">${formatAverage(subj.average)}</span>` : "";
      return `<article class="subject">
        <div class="subject-head">
          <h3>${escapeHtml(subj.name)}</h3>
          ${avg}
        </div>
        <div class="marks">${marksHtml}</div>
        <div class="subject-details"></div>
      </article>`;
    }).join("");

  bindMarkDetails(list);
}

/**
 * Клик по оценке в «Успеваемости» раскрывает подробности прямо на странице:
 * тема, предмет, дата, вес, учитель, средний балл класса, оценки класса,
 * комментарий и файлы.
 */
function bindMarkDetails(list) {
  list.querySelectorAll(".mark-chip[data-mark-id]").forEach((chip) => {
    chip.addEventListener("click", () => toggleMarkDetails(chip));
    chip.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleMarkDetails(chip);
      }
    });
  });
}

async function toggleMarkDetails(chip) {
  const id = chip.dataset.markId;
  if (!id) return;

  const article = chip.closest(".subject");
  const box = article && article.querySelector(".subject-details");
  if (!box) return;

  const existing = box.querySelector(`.subject-details-item[data-details-id="${CSS.escape(String(id))}"]`);
  if (existing) {
    existing.remove();
    chip.setAttribute("aria-expanded", "false");
    return;
  }

  const item = document.createElement("div");
  item.className = "subject-details-item";
  item.dataset.detailsId = String(id);
  item.innerHTML = `
    <div class="subject-details-head">
      <span>Оценка ${escapeHtml(chip.dataset.markValue || "")} · ${escapeHtml(chip.dataset.markDate || "")}</span>
      <button class="subject-details-close" type="button" aria-label="Свернуть">×</button>
    </div>
    <div class="subject-details-body"><p class="meta">Загружаю подробности…</p></div>
  `;
  item.querySelector(".subject-details-close").addEventListener("click", () => {
    item.remove();
    chip.setAttribute("aria-expanded", "false");
  });
  box.appendChild(item);
  chip.setAttribute("aria-expanded", "true");

  const body = item.querySelector(".subject-details-body");
  try {
    const data = await loadDetails(id);
    body.innerHTML = renderAssignmentDetails(data, chip.dataset.markValue);
  } catch (error) {
    body.innerHTML = `<p class="hw-error">Не удалось загрузить: ${escapeHtml(userError(error.message))}</p>`;
  }
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

  // --- Вспомогательные ---
  const clampMark = (v) => Math.max(2, Math.min(5, Math.round(v)));
  const fmt = (v) => formatAverage(v);

  // Что показываем по предмету: выведенная оценка (если СГО её вывел),
  // иначе средняя за период.
  const shownValue = (s) => (mode === "current" && s.final != null ? s.final : s.average);

  // Сортируем по убыванию показанного балла
  subjects.sort((a, b) => Number(shownValue(b)) - Number(shownValue(a)));

  // Распределение по округлённым отметкам
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0 };
  subjects.forEach((s) => distribution[clampMark(shownValue(s))]++);

  // Общий балл считаем сами, но теперь с учётом весов оценок (10/15/20/30):
  // вес предмета — сумма весов его оценок, долг входит как «2».
  // Средние из СГО (subject.average) при этом не трогаем — они остаются как есть.
  const weightedSubjects = subjects.filter(
    (s) => s.weightedAverage != null && Number(s.weight) > 0,
  );
  let commonAvg;
  if (weightedSubjects.length) {
    let sum = 0;
    let weights = 0;
    for (const s of weightedSubjects) {
      sum += Number(s.weightedAverage) * Number(s.weight);
      weights += Number(s.weight);
    }
    commonAvg = sum / weights;
  } else {
    // Весов нет (например, данные только из дашборда) — считаем как раньше.
    commonAvg = subjects.reduce((sum, s) => sum + s.average, 0) / subjects.length;
  }

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
          <div class="result-note">с учётом весов</div>
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
    // Что показываем по предмету: выведенную оценку, если СГО её уже вывел,
    // иначе — среднюю за период. Так понятно, что именно выведено в триместре.
    const hasFinal = mode === "current" && s.final != null;
    const value = shownValue(s);

    const pctBar = Math.max(0, Math.min(100, (Number(value) / 5) * 100)).toFixed(1);
    const level = clampMark(value);

    let medal;
    if (index === 0) medal = `<span class="result-medal">🥇</span>`;
    else if (index === 1) medal = `<span class="result-medal">🥈</span>`;
    else if (index === 2) medal = `<span class="result-medal">🥉</span>`;
    else medal = `<span class="result-medal result-medal-num">${index + 1}</span>`;

    // Подпись под оценкой: что именно показано и сколько оценок за период.
    let extra = "";
    if (mode === "current") {
      const label = hasFinal ? "выведенная" : "средняя за период";
      const count = s.marksCount ? ` · ${s.marksCount} оц.` : "";
      extra = `<small class="result-note">${label}${count}</small>`;
    }

    return `
      <div class="result-card">
        ${medal}
        <div class="result-main">
          <div class="result-name-row">
            <span class="result-name">${escapeHtml(s.name)}</span>
            <span class="result-score">${fmt(value)}</span>
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
    // Пустой список бывает двух видов: «пропусков нет» (отчёт разобран)
    // и «данных нет» (отчёт не пришёл/не разобрался). Не путаем их.
    if (att.available === false || data.error) {
      const reason = data.error ? escapeHtml(data.error) : "Посещаемость не удалось получить.";
      list.innerHTML = `<div class="empty"><strong>Нет данных</strong>${reason}</div>`;
      return;
    }
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