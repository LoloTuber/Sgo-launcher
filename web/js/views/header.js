import { state } from '../state.js';
import { formatAverage, shortDate } from '../utils.js';
import { overallAverage } from '../weights.js';

/**
 * Средний балл в шапке.
 *
 * Берём взвешенное среднее по загруженным оценкам (вес задания, долг = 2).
 * Если оценок ещё нет — показываем значение из дашборда СГО.
 */
export function renderHeaderAverage() {
  const student = state.quick && state.quick.student;
  const weighted = state.grades ? overallAverage(state.grades.subjects) : null;
  const value = weighted != null ? weighted : (student && student.average);

  const box = document.querySelector("#avg-box");
  const label = document.querySelector("#avg");
  if (value == null || !Number.isFinite(Number(value))) {
    if (box) box.hidden = true;
    return;
  }
  if (label) label.textContent = formatAverage(value);
  if (box) box.hidden = false;
}

export function renderHeader(student) {
  if (!student) return;
  const bits = [student.name, student.class && `${student.class} класс`, student.term]
    .filter(Boolean);
  document.querySelector("#who").textContent = bits.join(" · ") || "Дневник";

  renderHeaderAverage();

  const vacBox = document.querySelector("#vac-box");
  if (student.vacation) {
    const d = student.vacation.days;
    if (d === 0) {
      document.querySelector("#vac-days").textContent = "Ура!";
      document.querySelector("#vac-label").textContent = "каникулы!";
    } else if (d === 1) {
      // «1 день» ни о чём не говорит — пишем прямо: завтра каникулы.
      document.querySelector("#vac-days").textContent = "Завтра";
      document.querySelector("#vac-label").textContent = "каникулы";
    } else {
      document.querySelector("#vac-days").textContent = d;
      document.querySelector("#vac-label").textContent = "до каникул";
    }
    const start = student.vacation.start ? ` · с ${shortDate(student.vacation.start)}` : "";
    vacBox.title = `${student.vacation.name}${start}`;
    vacBox.hidden = false;
  } else {
    vacBox.hidden = true;
  }
}
