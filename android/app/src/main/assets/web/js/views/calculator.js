import { state } from '../state.js';
import { escapeHtml, shortDate, markCls } from '../utils.js';

export function renderCalculator(data) {
  const sel = document.querySelector("#calc-subject");
  const weightSel = document.querySelector("#calc-weight");
  const content = document.querySelector("#calc-content");
  
  if (!data || !data.subjects || !data.subjects.length) {
    sel.innerHTML = `<option value="">Нет предметов</option>`;
    content.innerHTML = `<div class="empty"><strong>Нет данных</strong>Оценок за этот период нет.</div>`;
    return;
  }

  if (weightSel) {
    state.calcWeight = parseInt(weightSel.value) || 10;
    weightSel.onchange = () => {
      state.calcWeight = parseInt(weightSel.value) || 10;
      calcSubject(sel.value);
    };
  }

  const saved = sel.value;
  sel.innerHTML = data.subjects.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join("");
  if (saved && data.subjects.some(s => s.name === saved)) sel.value = saved;

  sel.onchange = () => {
    state.simMarkId = null;
    calcSubject(sel.value);
  };
  
  state.simMarkId = null;
  calcSubject(sel.value);
}

export function calcSubject(subjectName) {
  const data = state.grades;
  const content = document.querySelector("#calc-content");
  if (!data) return;
  
  const subj = data.subjects.find(s => s.name === subjectName);
  if (!subj) {
    content.innerHTML = `<div class="empty">Выберите предмет</div>`;
    return;
  }

  const originalMarks = subj.marks || [];
  if (!originalMarks.length) {
    content.innerHTML = `<div class="empty">По этому предмету пока нет оценок.</div>`;
    return;
  }

  // Генерируем уникальные ID для каждой оценки, если их нет (например, при парсинге HTML)
  const marks = originalMarks.map((m, index) => {
    const hasValidId = m.id !== undefined && m.id !== null && m.id !== 0;
    return {
      ...m,
      uniqueId: hasValidId ? String(m.id) : `idx_${index}`
    };
  });

  let stats = { 5: 0, 4: 0, 3: 0, 2: 0 };
  let sum = 0, weightSum = 0;
  
  marks.forEach(m => {
    const v = parseFloat(String(m.value).replace(",", "."));
    if (!isNaN(v) && v > 0) {
      if (v >= 2 && v <= 5) stats[Math.floor(v)]++;
      
      const w = Number(m.weight) || 1;
      sum += v * w;
      weightSum += w;
    }
  });
  
  // Берем средний балл из бэкенда, если он есть (он точный, как в СГО)
  const currentAvg = (subj.average != null && !isNaN(parseFloat(subj.average))) 
      ? parseFloat(subj.average) 
      : (weightSum > 0 ? (sum / weightSum) : 0);

  // Генерация идеально четкой SVG диаграммы
  const total = stats[5] + stats[4] + stats[3] + stats[2];
  let chartHtml = "";
  
  if (total > 0) {
    const colors = { 5: "#10b981", 4: "#3b82f6", 3: "#f59e0b", 2: "#ef4444" };
    const r = 42; 
    const c = 2 * Math.PI * r; 
    let offset = 0;
    let circles = "";

    [5, 4, 3, 2].forEach(grade => {
      const count = stats[grade];
      if (count === 0) return;
      const pct = count / total;
      const dash = pct * c;
      
      circles += `<circle cx="50" cy="50" r="${r}" fill="transparent" stroke="${colors[grade]}" stroke-width="14" stroke-dasharray="${dash} ${c}" stroke-dashoffset="${-offset}" />`;
      offset += dash;
    });

    chartHtml = `
      <div class="pie-chart-container">
        <svg width="140" height="140" viewBox="0 0 100 100" class="pie-chart">
          <g transform="rotate(-90 50 50)">
            ${circles}
          </g>
          <text x="50" y="53" text-anchor="middle" font-size="24" font-weight="900" fill="var(--ink)" style="font-family: Arial, sans-serif;">${total}</text>
          <text x="50" y="67" text-anchor="middle" font-size="9" font-weight="bold" fill="var(--ink-soft)" style="font-family: Arial, sans-serif; letter-spacing: 0.5px;">ОЦЕНОК</text>
        </svg>
        <div class="pie-legend">
          ${[5,4,3,2].map(g => stats[g] ? `<div class="legend-item"><span class="legend-color" style="background:${colors[g]}"></span> ${g} <span style="opacity:0.6;font-weight:normal;margin-left:4px;">(${stats[g]})</span></div>` : "").join("")}
        </div>
      </div>
    `;
  }

  let newSum = 0, newWeightSum = 0;
  let simulatedValue = null;
  
  marks.forEach(m => {
    let v = parseFloat(String(m.value).replace(",", "."));
    const isDot = m.value === "." || m.value === "-";
    const w = Number(m.weight) || 1;
    
    // Сравниваем по uniqueId, чтобы не было конфликтов
    if (String(m.uniqueId) === String(state.simMarkId)) {
      if (isDot) {
        v = 3; // При исправлении точки ставим 3
      } else if (!isNaN(v)) {
        v += 1;
      }
      simulatedValue = v;
    }

    if (!isNaN(v) && v > 0) {
      newSum += v * w;
      newWeightSum += w;
    }
  });
  
  const newAvg = newWeightSum > 0 ? (newSum / newWeightSum) : 0;
  const isSimulated = state.simMarkId !== null;

  function calcTarget(targetMark, targetAvg, w) {
    if (newAvg >= targetAvg) {
      if (targetMark >= targetAvg) return "Уже есть!";
      const safe = (newSum - targetAvg * newWeightSum) / (w * (targetAvg - targetMark));
      const val = Math.floor(safe);
      if (val <= 0) return "Нельзя (балл упадёт)";
      if (val > 20) return "> 20 шт.";
      return `Можно <b>${val}</b> шт.`;
    } else {
      if (targetMark <= targetAvg) return "Невозможно";
      const needed = (targetAvg * newWeightSum - newSum) / (w * (targetMark - targetAvg));
      const val = Math.ceil(needed);
      if (val > 100) return "> 100 шт.";
      return `Нужно <b>${val}</b> шт.`;
    }
  }
  
  const w = state.calcWeight;
  const to5_5 = calcTarget(5, 4.5, w);
  const to5_4 = calcTarget(4, 4.5, w);
  const to4_4 = calcTarget(4, 3.5, w);
  const to4_3 = calcTarget(3, 3.5, w);

  const list = marks.map(m => {
    let v = parseFloat(String(m.value).replace(",", "."));
    const isDot = m.value === "." || m.value === "-";
    const isSim = String(m.uniqueId) === String(state.simMarkId);
    const wBadge = m.weight > 1 ? `<span class="weight-badge">x${m.weight}</span>` : "";
    
    let btn = "";
    if ((!isNaN(v) && v >= 1 && v <= 4) || isDot) {
      btn = `<button class="btn-plus ${isSim ? 'used' : ''}" data-mark-id="${escapeHtml(m.uniqueId)}">${isSim ? '-1' : '+1'}</button>`;
    } else {
      btn = `<button class="btn-plus used" disabled>+1</button>`;
    }

    return `
      <div class="calc-row ${isSim ? 'simulated' : ''}">
        <span class="mark-value ${markCls(isSim ? simulatedValue : m.value)}">${isSim ? simulatedValue : escapeHtml(m.value)}</span>
        <div class="calc-row-info">
          <div class="calc-row-topic">${escapeHtml(m.topic || "Без темы")} ${wBadge}</div>
          <div class="calc-row-meta">${escapeHtml(shortDate(m.date))} · ${escapeHtml(m.type || "Оценка")}</div>
        </div>
        ${btn}
      </div>
    `;
  }).join("");

  const simBanner = isSimulated ? `
    <div class="sim-result">
      <span>Симуляция:</span>
      <span class="old">${currentAvg.toFixed(2).replace(".", ",")}</span>
      <span>→</span>
      <span class="new">${newAvg.toFixed(2).replace(".", ",")}</span>
      <button class="btn-outline" style="margin-left:auto;padding:4px 10px;font-size:12px;" id="sim-reset">Сбросить</button>
    </div>
  ` : "";

  content.innerHTML = `
    <div class="calc-card">
      <div class="calc-title" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <span>${isSimulated ? 'Балл с симуляцией' : 'Текущий балл'}:</span>
        <span style="color:${isSimulated ? 'var(--green-600)' : 'inherit'}; font-size: 24px;">${(isSimulated ? newAvg : currentAvg).toFixed(2).replace(".", ",")}</span>
      </div>
      
      <div class="calc-dashboard">
        ${chartHtml}
        
        <div class="calc-targets">
          <div class="calc-target-item">
            <strong>До «5» (4.5)</strong>
            <div style="font-size:14px; margin-top:4px;">Пятёрками: ${to5_5}</div>
            <div style="font-size:14px; margin-top:4px;">Четвёрками: ${to5_4}</div>
          </div>
          <div class="calc-target-item">
            <strong>До «4» (3.5)</strong>
            <div style="font-size:14px; margin-top:4px;">Четвёрками: ${to4_4}</div>
            <div style="font-size:14px; margin-top:4px;">Тройками: ${to4_3}</div>
          </div>
        </div>
      </div>
      
      <p style="font-size:12px;color:var(--ink-soft);margin-top:16px;">* Расчёт для новых оценок с весом <b>${w}</b>.</p>
    </div>

    <div class="calc-card">
      <div class="calc-title">Симулятор «Что если»</div>
      <p style="font-size:13px;color:var(--ink-soft);margin-bottom:12px;">Нажмите «+1» на любой оценке (или долге), чтобы увидеть, как изменятся баллы.</p>
      <div class="calc-list">${list}</div>
      ${simBanner}
    </div>
  `;

  document.querySelectorAll(".btn-plus").forEach(btn => {
    if (btn.disabled) return;
    btn.onclick = () => {
      if (state.simMarkId === btn.dataset.markId) {
        state.simMarkId = null;
      } else {
        state.simMarkId = btn.dataset.markId;
      }
      calcSubject(subjectName);
    };
  });

  const resetBtn = document.querySelector("#sim-reset");
  if (resetBtn) {
    resetBtn.onclick = () => {
      state.simMarkId = null;
      calcSubject(subjectName);
    };
  }
}