import { markNumber } from './utils.js';

/**
 * Единая арифметика весов.
 *
 * Правила, общие для всего приложения:
 *  - вес оценки берётся из задания в дневнике; если вес неизвестен — 1;
 *  - долг («.» или «-») в расчёте среднего равен «2»;
 *  - среднее по предмету — взвешенное: Σ(оценка × вес) / Σ(вес);
 *  - общий балл — взвешенное среднее по всем предметам, где «вес предмета»
 *    равен сумме весов его оценок, а не количеству оценок.
 *
 * Раньше эти правила были продублированы в analytics.js и calculator.js,
 * а часть экранов («Итоги», шапка, «Сегодня») брала средние из отчёта СГО,
 * где вес не учитывается. Теперь все считают по этому модулю.
 */

/** Веса, доступные в интерфейсе. Держим в одном месте с index.html. */
export const WEIGHT_OPTIONS = [1, 10, 15, 20, 30];

/** Вес оценки. 1 — если вес неизвестен или некорректен. */
export function weightOf(mark) {
  const weight = Number(mark && mark.weight);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

/**
 * Числовое значение оценки. Долг («.»/«-») считается как «2»,
 * значения вне диапазона 1..5 отбрасываются.
 */
export function valueOf(mark) {
  const value = markNumber(mark && mark.value, 2);
  return value != null && value >= 1 && value <= 5 ? value : null;
}

/** Взвешенные суммы по списку оценок: sum = Σ(оценка × вес), weights = Σ(вес). */
export function weightedSums(marks) {
  let sum = 0;
  let weights = 0;
  let count = 0;
  for (const mark of marks || []) {
    const value = valueOf(mark);
    if (value == null) continue;
    const weight = weightOf(mark);
    sum += value * weight;
    weights += weight;
    count += 1;
  }
  return { sum, weights, count };
}

/** Взвешенное среднее по списку оценок. */
export function weightedAverage(marks) {
  const { sum, weights } = weightedSums(marks);
  return weights ? sum / weights : null;
}

/** Взвешенное среднее по предмету. */
export function subjectAverage(subject) {
  if (!subject) return null;
  return weightedAverage(subject.marks || []);
}

/** Сумма весов оценок предмета — «вес» предмета в общем среднем. */
export function subjectWeight(subject) {
  const { weights } = weightedSums(subject && subject.marks);
  return weights;
}

/**
 * Общий балл: взвешенное среднее по всем предметам сразу.
 * Так каждый предмет влияет пропорционально сумме весов своих оценок,
 * а не количеству оценок и не поровну.
 */
export function overallAverage(subjects) {
  let sum = 0;
  let weights = 0;
  for (const subject of subjects || []) {
    const marks = subject && subject.marks;
    if (!marks) continue;
    const subjectSums = weightedSums(marks);
    sum += subjectSums.sum;
    weights += subjectSums.weights;
  }
  return weights ? sum / weights : null;
}

/** Самый частый вес в предмете — для подсказок вида «нужно N пятёрок». */
export function typicalWeight(subject, fallback = 10) {
  const counts = new Map();
  for (const mark of (subject && subject.marks) || []) {
    if (valueOf(mark) == null) continue;
    const weight = weightOf(mark);
    counts.set(weight, (counts.get(weight) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [weight, count] of counts) {
    if (count > bestCount) {
      best = weight;
      bestCount = count;
    }
  }
  return best == null ? fallback : best;
}

/**
 * Сколько оценок со значением markValue и весом markWeight нужно,
 * чтобы дойти до целевого среднего.
 */
export function marksNeeded(marks, target, markValue = 5, markWeight = 10) {
  const { sum, weights } = weightedSums(marks);
  if (!weights) return null;
  const current = sum / weights;
  if (current >= target) return 0;
  if (markValue <= target) return null;
  const needed = (target * weights - sum) / (markWeight * (markValue - target));
  return Math.max(0, Math.ceil(needed - 1e-9));
}
