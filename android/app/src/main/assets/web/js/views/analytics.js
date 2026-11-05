import { state } from '../state.js';
import {
  escapeHtml, shortDate, markCls, weekStartIso, isDebtMark, markNumber
} from '../utils.js';
import { isNewMark, newMarksCount } from '../changes.js';

/**
 * Аналитика успеваемости.
 *
 * Всё считается на клиенте по уже загруженным оценкам:
 *  - средний балл по неделям (SVG-график);
 *  - прогноз итоговой оценки по текущей динамике;
 *  - предметы в зоне риска;
 *  - как последние оценки изменили средний балл.
 *
 * Прогноз — эвристика, а не официальная оценка. Об этом честно написано в UI.
 */

let selectedSubject = "all";

function numericValue(mark) {
  const value = markNumber(mark && mark.value);
  return value != null && value >= 1 && value <= 5 ? value : null;
}

function weightOf(mark) {
  const weight = Number(mark && mark.weight);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function marksOf(subject) {
  return (subject.marks || [])
    .filter((mark) => numericValue(mark) != null)
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

function weightedAverage(marks) {
  let sum = 0;
  let weights = 0;
  for (const mark of marks) {
    const value = numericValue(mark);
    if (value == null) continue;
    const weight = weightOf(mark);
    sum += value * weight;
    weights += weight;
  }
  return weights ? sum / weights : null;
}

function weightedSums(marks) {
  let sum = 0;
  let weights = 0;
  for (const mark of marks) {
    const value = numericValue(mark);
    if (value == null) continue;
    const weight = weightOf(mark);
    sum += value * weight;
    weights += weight;
  }
  return { sum, weights };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function fmt(value) {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(2).replace(".", ",");
}

function trendSlope(values) {
  const points = values.slice(-8);
  const n = points.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = points.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - meanX) * (points[i] - meanY);
    denominator += (i - meanX) ** 2;
  }
  return denominator ? numerator / denominator : 0;
}

function analyzeSubject(subject) {
  const marks = marksOf(subject);
  const dots = (subject.marks || []).filter(
    (mark) => isDebtMark(mark.value)
  ).length;

  if (!marks.length) {
    return {
      name: subject.name,
      marks,
      dots,
      count: 0,
      current: null,
      recent: null,
      predictedRaw: null,
      predictedMark: null,
      slope: 0,
      risk: dots > 0,
      riskReasons: dots ? [`${dots} долг(ов)`] : [],
    };
  }

  const values = marks.map(numericValue);
  const weights = marks.map(weightOf);
  // Считаем локально, чтобы долги-точки входили в средний балл как «2».
  const current = weightedAverage(marks);

  // Последние оценки важнее старых: вес растёт с каждой новой отметкой.
  const recentValues = values.slice(-5);
  const recentWeights = weights.slice(-5);
  let recentSum = 0;
  let recentWeightSum = 0;
  recentValues.forEach((value, index) => {
    const factor = 1 + index * 0.35;
    recentSum += value * recentWeights[index] * factor;
    recentWeightSum += recentWeights[index] * factor;
  });
  const recent = recentWeightSum ? recentSum / recentWeightSum : current;

  const slope = trendSlope(values);
  const predictedRaw = clamp(recent + slope * 2, 2, 5);
  const predictedMark = clamp(Math.round(predictedRaw), 2, 5);

  const riskReasons = [];
  if (dots) riskReasons.push(`${dots} долг(ов)`);
  if (current != null && current < 3.5) riskReasons.push(`средний ${fmt(current)}`);
  if (slope < -0.08 && current < 4.2) riskReasons.push("балл снижается");

  return {
    name: subject.name,
    marks,
    dots,
    count: marks.length,
    current,
    recent,
    predictedRaw,
    predictedMark,
    slope,
    risk: riskReasons.length > 0,
    riskReasons,
  };
}

/** Сколько пятёрок (вес 10) нужно, чтобы дойти до целевого среднего. */
function marksNeeded(subject, target, markValue = 5, markWeight = 10) {
  const marks = marksOf(subject);
  const { sum, weights } = weightedSums(marks);
  if (!weights) return null;
  const current = sum / weights;
  if (current >= target) return 0;
  const needed = (target * weights - sum) / (markWeight * (markValue - target));
  return Math.max(0, Math.ceil(needed - 1e-9));
}

function weeklySeries(subjectName) {
  const buckets = new Map();

  for (const subject of state.grades.subjects || []) {
    if (subjectName !== "all" && subject.name !== subjectName) continue;
    for (const mark of subject.marks || []) {
      const value = numericValue(mark);
      if (value == null) continue;
      const week = weekStartIso(mark.date);
      if (!week) continue;
      const bucket = buckets.get(week) || { sum: 0, weights: 0, count: 0 };
      const weight = weightOf(mark);
      bucket.sum += value * weight;
      bucket.weights += weight;
      bucket.count += 1;
      buckets.set(week, bucket);
    }
  }

  return Array.from(buckets.entries())
    .filter(([, bucket]) => bucket.weights > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, bucket]) => ({
      week,
      average: bucket.sum / bucket.weights,
      count: bucket.count,
    }));
}

function buildChart(series, subjectName) {
  if (!series.length) {
    return `<div class="analytics-empty">Недостаточно оценок для графика.</div>`;
  }

  const width = 760;
  const height = 280;
  const left = 46;
  const right = 22;
  const top = 22;
  const bottom = 44;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const x = (index) => series.length === 1
    ? left + plotWidth / 2
    : left + (index / (series.length - 1)) * plotWidth;
  const y = (value) => top + ((5 - value) / 3) * plotHeight;

  const grid = [5, 4, 3, 2].map((value) => `
    <line class="analytics-grid-line" x1="${left}" y1="${y(value)}"
          x2="${left + plotWidth}" y2="${y(value)}" />
    <text class="analytics-axis-label" x="${left - 10}" y="${y(value) + 4}"
          text-anchor="end">${value}</text>
  `).join("");

  const points = series.map((point, index) => ({
    ...point,
    x: x(index),
    y: y(point.average),
  }));

  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = `${left},${top + plotHeight} ${line} ${left + plotWidth},${top + plotHeight}`;

  const step = Math.max(1, Math.ceil(points.length / 6));
  const xLabels = points.map((point, index) => {
    if (index % step !== 0 && index !== points.length - 1) return "";
    return `<text class="analytics-axis-label" x="${point.x}" y="${height - 14}"
                  text-anchor="middle">${shortDate(point.week)}</text>`;
  }).join("");

  const dots = points.map((point) => `
    <circle class="analytics-point" cx="${point.x}" cy="${point.y}" r="4.5">
      <title>Неделя ${shortDate(point.week)}: ${fmt(point.average)} (${point.count} оц.)</title>
    </circle>
  `).join("");

  const last = points[points.length - 1];
  const targetY = y(4.5);

  return `
    <div class="analytics-chart-wrap">
      <svg class="analytics-chart" viewBox="0 0 ${width} ${height}" role="img"
           aria-label="Средний балл по неделям: ${escapeHtml(subjectName === "all" ? "все предметы" : subjectName)}">
        ${grid}
        <line class="analytics-target-line" x1="${left}" y1="${targetY}"
              x2="${left + plotWidth}" y2="${targetY}" />
        <text class="analytics-target-label" x="${left + plotWidth}" y="${targetY - 6}"
              text-anchor="end">уровень «5» (4,5)</text>
        <polygon class="analytics-area" points="${area}" />
        <polyline class="analytics-line" points="${line}" />
        ${dots}
        ${xLabels}
        <text class="analytics-last-label" x="${last.x}" y="${last.y - 12}"
              text-anchor="middle">${fmt(last.average)}</text>
      </svg>
    </div>
  `;
}

function renderForecast(analyses) {
  const list = analyses.filter((item) => item.count);
  if (!list.length) {
    return `<div class="analytics-empty">Нет оценок для прогноза.</div>`;
  }

  const rows = list
    .slice()
    .sort((a, b) => (a.current || 0) - (b.current || 0))
    .map((item) => {
      const delta = item.current == null || item.predictedRaw == null
        ? 0
        : item.predictedRaw - item.current;
      const arrow = delta > 0.03 ? "▲" : delta < -0.03 ? "▼" : "→";
      const tone = delta > 0.03 ? "up" : delta < -0.03 ? "down" : "flat";
      return `
        <div class="forecast-row">
          <span class="forecast-name">${escapeHtml(item.name)}</span>
          <span class="forecast-current">${fmt(item.current)}</span>
          <span class="forecast-arrow ${tone}">${arrow}</span>
          <span class="forecast-predicted mark-value ${markCls(item.predictedMark)}">${item.predictedMark}</span>
          <span class="forecast-note">${item.count} оц.</span>
        </div>
      `;
    }).join("");

  return `<div class="forecast-list">${rows}</div>`;
}

function renderRisk(analyses) {
  const risky = analyses.filter((item) => item.risk);
  if (!risky.length) {
    return `<div class="analytics-empty analytics-ok">В зоне риска нет предметов — так держать! ✅</div>`;
  }

  return `<div class="risk-list">${risky.map((item) => {
    let hint = "Следите за новыми оценками";
    if (item.current != null && item.current < 3.5) {
      const needed = marksNeeded(state.grades.subjects.find((s) => s.name === item.name), 3.5);
      hint = needed == null
        ? "Средний балл ниже 3,5"
        : needed === 0
          ? "Порог 3,5 уже достигнут"
          : `До 3,5: ${needed} «5» (вес 10)`;
    } else if (item.dots) {
      hint = "Сначала закройте долги";
    } else if (item.slope < -0.08) {
      hint = "Балл снижается — стоит подтянуть";
    }

    return `
      <div class="risk-row">
        <div class="risk-main">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.riskReasons.join(" · "))}</span>
        </div>
        <div class="risk-side">
          <span class="risk-average">${fmt(item.current)}</span>
          <small>${escapeHtml(hint)}</small>
        </div>
      </div>
    `;
  }).join("")}</div>`;
}

function renderDynamics(analyses) {
  const rows = [];

  for (const item of analyses) {
    if (item.marks.length < 2) continue;
    const before = weightedAverage(item.marks.slice(0, -1));
    const after = weightedAverage(item.marks);
    if (before == null || after == null) continue;

    const last = item.marks[item.marks.length - 1];
    const isFresh = isNewMark(item.name, last);
    rows.push({
      name: item.name,
      before,
      after,
      delta: after - before,
      last,
      isFresh,
    });
  }

  rows.sort((a, b) => String(b.last.date || "").localeCompare(String(a.last.date || "")));
  const shown = rows.slice(0, 10);

  if (!shown.length) {
    return `<div class="analytics-empty">Динамика появится, когда будет хотя бы две оценки по предмету.</div>`;
  }

  return `<div class="dynamics-list">${shown.map((row) => {
    const delta = row.delta;
    const tone = delta > 0.001 ? "up" : delta < -0.001 ? "down" : "flat";
    const sign = delta > 0 ? "+" : "";
    return `
      <div class="dynamics-row ${row.isFresh ? "is-new" : ""}">
        <span class="dynamics-name">${escapeHtml(row.name)}${row.isFresh ? ` <span class="new-badge">новое</span>` : ""}</span>
        <span class="dynamics-last">
          <span class="mark-value ${markCls(numericValue(row.last))}">${escapeHtml(row.last.value)}</span>
          <small>${escapeHtml(shortDate(row.last.date))}</small>
        </span>
        <span class="dynamics-change ${tone}">${fmt(row.before)} → ${fmt(row.after)}
          <b>${sign}${fmt(delta)}</b>
        </span>
      </div>
    `;
  }).join("")}</div>`;
}

export function renderAnalytics(data) {
  const content = document.querySelector("#analytics-content");
  const sub = document.querySelector("#analytics-sub");
  const select = document.querySelector("#analytics-subject");
  if (!content) return;

  if (!data || !Array.isArray(data.subjects) || !data.subjects.length) {
    if (sub) sub.textContent = "Недостаточно данных";
    content.innerHTML = `<div class="empty"><strong>Пока нет оценок</strong>Аналитика появится после первой выставленной оценки.</div>`;
    if (select) select.innerHTML = `<option value="all">Все предметы</option>`;
    return;
  }

  const names = data.subjects
    .filter((subject) => marksOf(subject).length)
    .map((subject) => subject.name);

  if (selectedSubject !== "all" && !names.includes(selectedSubject)) {
    selectedSubject = "all";
  }

  if (select) {
    select.innerHTML = `<option value="all">Все предметы</option>` + names
      .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
      .join("");
    select.value = selectedSubject;
    select.onchange = () => {
      selectedSubject = select.value;
      renderAnalytics(state.grades);
    };
  }

  const analyses = data.subjects.map(analyzeSubject);
  const withMarks = analyses.filter((item) => item.count);
  const risky = analyses.filter((item) => item.risk);
  const fresh = newMarksCount();

  const predictedAverage = withMarks.length
    ? withMarks.reduce((sum, item) => sum + (item.predictedRaw || item.current || 0), 0) / withMarks.length
    : null;

  const best = withMarks.slice().sort((a, b) => (b.current || 0) - (a.current || 0))[0];
  const series = weeklySeries(selectedSubject);
  const chartTitle = selectedSubject === "all" ? "Все предметы" : selectedSubject;

  if (sub) {
    sub.textContent = data.term
      ? `${data.term} · прогноз и динамика`
      : "Прогноз и динамика по текущим оценкам";
  }

  content.innerHTML = `
    <div class="analytics-kpi-grid">
      <div class="analytics-kpi">
        <span class="analytics-kpi-label">Прогноз среднего</span>
        <strong>${fmt(predictedAverage)}</strong>
        <small>по текущей динамике</small>
      </div>
      <div class="analytics-kpi ${risky.length ? "is-risk" : "is-ok"}">
        <span class="analytics-kpi-label">В зоне риска</span>
        <strong>${risky.length}</strong>
        <small>${risky.length ? "нужно внимание" : "всё спокойно"}</small>
      </div>
      <div class="analytics-kpi ${fresh ? "is-fresh" : ""}">
        <span class="analytics-kpi-label">Новых оценок</span>
        <strong>${fresh}</strong>
        <small>${fresh ? "с прошлой загрузки" : "нет новых"}</small>
      </div>
      <div class="analytics-kpi">
        <span class="analytics-kpi-label">Лучший предмет</span>
        <strong class="analytics-kpi-text">${best ? escapeHtml(best.name) : "—"}</strong>
        <small>${best ? `средний ${fmt(best.current)}` : "нет данных"}</small>
      </div>
    </div>

    <div class="analytics-card">
      <div class="analytics-card-head">
        <div>
          <h3>Средний балл по неделям</h3>
          <p class="subtle">${escapeHtml(chartTitle)} · взвешенный балл</p>
        </div>
      </div>
      ${buildChart(series, selectedSubject)}
    </div>

    <div class="analytics-card">
      <div class="analytics-card-head">
        <div>
          <h3>Прогноз итоговых оценок</h3>
          <p class="subtle">Текущий средний → вероятная итоговая отметка</p>
        </div>
      </div>
      ${renderForecast(analyses)}
    </div>

    <div class="analytics-columns">
      <div class="analytics-card">
        <div class="analytics-card-head">
          <div>
            <h3>Предметы в зоне риска</h3>
            <p class="subtle">Низкий средний, долги или падение</p>
          </div>
        </div>
        ${renderRisk(analyses)}
      </div>

      <div class="analytics-card">
        <div class="analytics-card-head">
          <div>
            <h3>Динамика после новых оценок</h3>
            <p class="subtle">Как последняя отметка изменила средний</p>
          </div>
        </div>
        ${renderDynamics(analyses)}
      </div>
    </div>

    <p class="analytics-disclaimer">
      * Прогноз рассчитывается по текущим отметкам и их динамике. Это подсказка, а не гарантия итоговой оценки.
    </p>
  `;
}
