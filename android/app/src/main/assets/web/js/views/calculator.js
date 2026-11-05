import { state } from '../state.js';
import { escapeHtml, shortDate, markCls, isDebtMark, markNumber } from '../utils.js';

/**
 * Калькулятор «что если».
 *
 * Можно:
 *  - добавить +1/+2/+3 к существующей оценке (с ограничением до 5);
 *  - превратить долг («.»/«-») в 3, 4 или 5;
 *  - добавить произвольное количество новых оценок с выбранным весом;
 *  - сразу увидеть, как изменится средний балл и итоговая отметка.
 */

function resetSimulation() {
  state.simAdjustments = {};
  state.simAdded = [];
}

function numericValue(value) {
  return markNumber(value);
}

function isDot(value) {
  return isDebtMark(value);
}

function weightOf(mark) {
  const weight = Number(mark && mark.weight);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function clampMark(value) {
  return Math.max(2, Math.min(5, value));
}

function fmt(value) {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(2).replace(".", ",");
}

function prepareMarks(subject) {
  return (subject.marks || []).map((mark, index) => {
    const hasId = mark.id !== undefined && mark.id !== null && mark.id !== 0;
    return {
      ...mark,
      uniqueId: hasId ? `id:${mark.id}` : `idx:${index}`,
      weightValue: weightOf(mark),
      baseValue: numericValue(mark.value),
      dot: isDot(mark.value),
    };
  });
}

function calcStats(values) {
  const stats = { 5: 0, 4: 0, 3: 0, 2: 0 };
  for (const value of values) {
    if (value == null) continue;
    const bucket = clampMark(Math.round(value));
    stats[bucket] = (stats[bucket] || 0) + 1;
  }
  return stats;
}

function chartHtml(stats) {
  const total = stats[5] + stats[4] + stats[3] + stats[2];
  if (!total) return "";

  const colors = { 5: "#10b981", 4: "#3b82f6", 3: "#f59e0b", 2: "#ef4444" };
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  let circles = "";

  [5, 4, 3, 2].forEach((grade) => {
    const count = stats[grade];
    if (!count) return;
    const dash = (count / total) * c;
    circles += `<circle cx="50" cy="50" r="${r}" fill="transparent" stroke="${colors[grade]}"
      stroke-width="14" stroke-dasharray="${dash} ${c}" stroke-dashoffset="${-offset}" />`;
    offset += dash;
  });

  return `
    <div class="pie-chart-container">
      <svg width="140" height="140" viewBox="0 0 100 100" class="pie-chart" aria-hidden="true">
        <g transform="rotate(-90 50 50)">${circles}</g>
        <text x="50" y="53" text-anchor="middle" font-size="24" font-weight="900"
              fill="var(--ink)" style="font-family: Arial, sans-serif;">${total}</text>
        <text x="50" y="67" text-anchor="middle" font-size="9" font-weight="bold"
              fill="var(--ink-soft)" style="font-family: Arial, sans-serif; letter-spacing: 0.5px;">ОЦЕНОК</text>
      </svg>
      <div class="pie-legend">
        ${[5, 4, 3, 2]
          .filter((grade) => stats[grade])
          .map((grade) => `<div class="legend-item">
            <span class="legend-color" style="background:${colors[grade]}"></span>
            ${grade}
            <span style="opacity:0.6;font-weight:normal;margin-left:4px;">(${stats[grade]})</span>
          </div>`)
          .join("")}
      </div>
    </div>
  `;
}

function neededCount(newSum, newWeightSum, newAvg, markValue, targetAverage, markWeight) {
  if (!newWeightSum) return "нет оценок";
  if (newAvg >= targetAverage) return "уже есть";
  if (markValue <= targetAverage) return "невозможно";

  const needed = (targetAverage * newWeightSum - newSum)
    / (markWeight * (markValue - targetAverage));
  const count = Math.ceil(needed - 1e-9);
  if (!Number.isFinite(count) || count > 100) return "> 100 шт.";
  if (count <= 0) return "уже есть";
  return `нужно ${count}`;
}

function markControls(mark) {
  if (mark.dot) {
    const current = state.simAdjustments[mark.uniqueId];
    return `
      <div class="sim-controls" title="Превратить долг в оценку">
        ${[3, 4, 5].map((value) => `
          <button class="btn-plus ${current === value ? "used" : ""}"
                  type="button" data-mark-id="${escapeHtml(mark.uniqueId)}" data-dot="${value}">
            ${value}
          </button>
        `).join("")}
        ${current ? `<button class="btn-sim-reset" type="button"
            data-mark-id="${escapeHtml(mark.uniqueId)}" title="Убрать симуляцию">↺</button>` : ""}
      </div>
    `;
  }

  if (mark.baseValue == null) return "";
  if (mark.baseValue >= 5) return `<span class="sim-max">макс.</span>`;

  return `
    <div class="sim-controls" title="Добавить баллы к оценке">
      ${[1, 2, 3].map((delta) => {
        const target = mark.baseValue + delta;
        const disabled = target > 5;
        const active = state.simAdjustments[mark.uniqueId] === delta;
        return `
          <button class="btn-plus ${active ? "used" : ""}"
                  type="button" data-mark-id="${escapeHtml(mark.uniqueId)}" data-delta="${delta}"
                  ${disabled ? "disabled" : ""}>+${delta}</button>
        `;
      }).join("")}
      ${state.simAdjustments[mark.uniqueId] ? `<button class="btn-sim-reset" type="button"
          data-mark-id="${escapeHtml(mark.uniqueId)}" title="Убрать симуляцию">↺</button>` : ""}
    </div>
  `;
}

export function renderCalculator(data) {
  const sel = document.querySelector("#calc-subject");
  const weightSel = document.querySelector("#calc-weight");
  const content = document.querySelector("#calc-content");
  if (!sel || !content) return;

  if (!data || !data.subjects || !data.subjects.length) {
    sel.innerHTML = `<option value="">Нет предметов</option>`;
    content.innerHTML = `<div class="empty"><strong>Нет данных</strong>Оценок за этот период нет.</div>`;
    return;
  }

  // При смене периода старые симуляции относятся к другому набору оценок.
  const term = data.term || "";
  if (state.calcTerm !== term) {
    state.calcTerm = term;
    resetSimulation();
  }

  if (!state.simAdjustments) state.simAdjustments = {};
  if (!Array.isArray(state.simAdded)) state.simAdded = [];

  if (weightSel) {
    state.calcWeight = parseInt(weightSel.value, 10) || 10;
    weightSel.onchange = () => {
      state.calcWeight = parseInt(weightSel.value, 10) || 10;
      calcSubject(sel.value);
    };
  }

  const saved = sel.value;
  sel.innerHTML = data.subjects
    .map((subject) => `<option value="${escapeHtml(subject.name)}">${escapeHtml(subject.name)}</option>`)
    .join("");
  if (saved && data.subjects.some((subject) => subject.name === saved)) {
    sel.value = saved;
  }

  sel.onchange = () => {
    resetSimulation();
    calcSubject(sel.value);
  };

  calcSubject(sel.value);
}

export function calcSubject(subjectName) {
  const data = state.grades;
  const content = document.querySelector("#calc-content");
  if (!data || !content) return;

  const subject = (data.subjects || []).find((item) => item.name === subjectName);
  if (!subject) {
    content.innerHTML = `<div class="empty">Выберите предмет</div>`;
    return;
  }

  if (!state.simAdjustments) state.simAdjustments = {};
  if (!Array.isArray(state.simAdded)) state.simAdded = [];

  const marks = prepareMarks(subject);

  let baseSum = 0;
  let baseWeightSum = 0;
  let newSum = 0;
  let newWeightSum = 0;
  const simulatedValues = [];

  for (const mark of marks) {
    const weight = mark.weightValue;
    let simulated = mark.baseValue;

    if (mark.dot) {
      const value = state.simAdjustments[mark.uniqueId];
      // Долг уже считается как «2», кнопки 3/4/5 позволяют его исправить.
      simulated = value ? clampMark(value) : mark.baseValue;
    } else if (mark.baseValue != null) {
      const delta = state.simAdjustments[mark.uniqueId];
      simulated = delta ? clampMark(mark.baseValue + delta) : mark.baseValue;
    }

    if (mark.baseValue != null) {
      baseSum += mark.baseValue * weight;
      baseWeightSum += weight;
    }

    mark.simulatedValue = simulated;
    if (simulated != null) {
      newSum += simulated * weight;
      newWeightSum += weight;
      simulatedValues.push(simulated);
    }
  }

  for (const added of state.simAdded) {
    const weight = Number(added.weight) || 1;
    newSum += added.value * weight;
    newWeightSum += weight;
    simulatedValues.push(added.value);
  }

  const baseAverage = baseWeightSum ? baseSum / baseWeightSum : null;
  // Считаем локально, чтобы долги-точки гарантированно входили как «2».
  const currentAverage = baseAverage;

  const newAverage = newWeightSum ? newSum / newWeightSum : null;

  const isSimulated = Object.keys(state.simAdjustments).some(
    (key) => state.simAdjustments[key] != null
  ) || state.simAdded.length > 0;

  const stats = calcStats(simulatedValues);
  const chart = chartHtml(stats);

  const rows = marks.map((mark) => {
    const adjusted = mark.dot ? state.simAdjustments[mark.uniqueId] : null;
    const changed = mark.simulatedValue != null && mark.simulatedValue !== mark.baseValue;
    const weightBadge = mark.weightValue > 1
      ? `<span class="weight-badge">x${mark.weightValue}</span>`
      : "";
    // Долг без симуляции показываем точкой, но в расчёте он уже равен «2».
    const shownValue = mark.dot && !adjusted
      ? mark.value
      : (mark.simulatedValue != null ? mark.simulatedValue : mark.value);

    return `
      <div class="calc-row ${changed ? "simulated" : ""}">
        <span class="mark-value ${markCls(shownValue)}">${escapeHtml(shownValue)}</span>
        <div class="calc-row-info">
          <div class="calc-row-topic">
            ${escapeHtml(mark.topic || "Без темы")} ${weightBadge}
          </div>
          <div class="calc-row-meta">
            ${escapeHtml(shortDate(mark.date))} · ${escapeHtml(mark.type || (mark.dot ? "Долг" : "Оценка"))}
            ${mark.dot ? " · в расчёте 2" : ""}
            ${changed ? ` · было ${escapeHtml(mark.value)}` : ""}
          </div>
        </div>
        ${markControls(mark)}
      </div>
    `;
  }).join("");

  const addedRows = state.simAdded.map((added, index) => `
    <div class="calc-row simulated sim-added-row">
      <span class="mark-value ${markCls(added.value)}">${escapeHtml(added.value)}</span>
      <div class="calc-row-info">
        <div class="calc-row-topic">Новая оценка</div>
        <div class="calc-row-meta">вес x${escapeHtml(added.weight)}</div>
      </div>
      <button class="btn-sim-reset" type="button" data-remove-added="${index}"
              title="Удалить оценку">✕</button>
    </div>
  `).join("");

  const weightOptions = [1, 5, 10, 15, 20, 30]
    .map((weight) => `<option value="${weight}" ${weight === state.calcWeight ? "selected" : ""}>Вес ${weight}</option>`)
    .join("");

  const valueOptions = [5, 4, 3, 2]
    .map((value) => `<option value="${value}">${value}</option>`)
    .join("");

  const targetWeight = state.calcWeight || 10;
  const to5 = newAverage != null ? neededCount(newSum, newWeightSum, newAverage, 5, 4.5, targetWeight) : "—";
  const to4 = newAverage != null ? neededCount(newSum, newWeightSum, newAverage, 4, 3.5, targetWeight) : "—";
  const to4With3 = newAverage != null ? neededCount(newSum, newWeightSum, newAverage, 3, 3.5, targetWeight) : "—";
  const to5With4 = newAverage != null ? neededCount(newSum, newWeightSum, newAverage, 4, 4.5, targetWeight) : "—";

  const resultBanner = isSimulated ? `
    <div class="sim-result">
      <span class="sim-result-label">Было</span>
      <span class="old">${fmt(currentAverage)}</span>
      <span>→</span>
      <span class="new">${fmt(newAverage)}</span>
      <span class="sim-delta ${newAverage != null && currentAverage != null && newAverage >= currentAverage ? "up" : "down"}">
        ${newAverage != null && currentAverage != null
          ? `${newAverage >= currentAverage ? "+" : ""}${fmt(newAverage - currentAverage)}`
          : ""}
      </span>
      <span class="sim-final">итог: <b>${newAverage != null ? clampMark(Math.round(newAverage)) : "—"}</b></span>
      <button class="btn-outline sim-reset-all" type="button" id="sim-reset">Сбросить</button>
    </div>
  ` : "";

  content.innerHTML = `
    <div class="calc-card">
      <div class="calc-title calc-average-title">
        <span>${isSimulated ? "Балл с симуляцией" : "Текущий балл"}:</span>
        <span class="${isSimulated ? "is-simulated" : ""}">${fmt(isSimulated ? newAverage : currentAverage)}</span>
      </div>

      <div class="calc-dashboard">
        ${chart}
        <div class="calc-targets">
          <div class="calc-target-item">
            <strong>До «5» (4,5)</strong>
            <div>Пятёрками: ${to5}</div>
            <div>Четвёрками: ${to5With4}</div>
          </div>
          <div class="calc-target-item">
            <strong>До «4» (3,5)</strong>
            <div>Четвёрками: ${to4}</div>
            <div>Тройками: ${to4With3}</div>
          </div>
        </div>
      </div>

      <p class="calc-hint">* Расчёт для новых оценок с весом <b>${targetWeight}</b>.</p>
    </div>

    <div class="calc-card">
      <div class="calc-title">Симулятор «Что если»</div>
      <p class="calc-hint">
        Нажмите «+1», «+2» или «+3» на оценке. Долг («.» или «-») по умолчанию считается как «2»,
        а кнопками 3, 4 или 5 его можно «исправить».
        Ниже можно добавить новую оценку с нужным весом.
      </p>

      ${rows || `<div class="today-muted">По этому предмету пока нет оценок.</div>`}
      ${addedRows ? `<div class="sim-added-list">${addedRows}</div>` : ""}

      <div class="sim-add-form">
        <span class="sim-add-title">Добавить оценку:</span>
        <select id="sim-add-value" class="term-select" aria-label="Значение новой оценки">${valueOptions}</select>
        <select id="sim-add-weight" class="term-select" aria-label="Вес новой оценки">${weightOptions}</select>
        <button class="btn" type="button" id="sim-add-btn">Добавить</button>
      </div>

      ${resultBanner}
    </div>
  `;

  content.querySelectorAll(".btn-plus[data-mark-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const markId = button.dataset.markId;
      if (button.dataset.dot != null) {
        const value = parseInt(button.dataset.dot, 10);
        state.simAdjustments[markId] = state.simAdjustments[markId] === value ? null : value;
      } else {
        const delta = parseInt(button.dataset.delta, 10);
        state.simAdjustments[markId] = state.simAdjustments[markId] === delta ? null : delta;
      }
      calcSubject(subjectName);
    });
  });

  content.querySelectorAll(".btn-sim-reset[data-mark-id]").forEach((button) => {
    button.addEventListener("click", () => {
      delete state.simAdjustments[button.dataset.markId];
      calcSubject(subjectName);
    });
  });

  content.querySelectorAll("[data-remove-added]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = parseInt(button.dataset.removeAdded, 10);
      if (Number.isFinite(index)) state.simAdded.splice(index, 1);
      calcSubject(subjectName);
    });
  });

  const addBtn = content.querySelector("#sim-add-btn");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      const valueEl = content.querySelector("#sim-add-value");
      const weightEl = content.querySelector("#sim-add-weight");
      const value = parseInt(valueEl && valueEl.value, 10);
      const weight = parseInt(weightEl && weightEl.value, 10);
      if (!Number.isFinite(value)) return;
      state.simAdded.push({ value: clampMark(value), weight: Number.isFinite(weight) ? weight : 1 });
      calcSubject(subjectName);
    });
  }

  const resetBtn = content.querySelector("#sim-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetSimulation();
      calcSubject(subjectName);
    });
  }
}
