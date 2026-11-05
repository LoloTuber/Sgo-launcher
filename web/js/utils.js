export const BELLS_40_MON = {
  0: ["08:00","08:20"], 1: ["08:25","09:05"], 2: ["09:10","09:50"], 3: ["10:05","10:45"],
  4: ["11:00","11:40"], 5: ["11:45","12:25"], 6: ["12:30","13:10"], 7: ["13:25","14:05"],
  8: ["14:10","14:50"], 9: ["14:55","15:15"]
};
export const BELLS_30_MON = {
  0: ["08:00","08:20"], 1: ["08:25","08:55"], 2: ["09:00","09:30"], 3: ["09:40","10:10"],
  4: ["10:20","10:50"], 5: ["10:55","11:25"], 6: ["11:30","12:00"], 7: ["12:10","12:40"],
  8: ["12:45","13:15"], 9: ["13:20","13:50"]
};
export const BELLS_40_OTH = {
  1: ["08:00","08:40"], 2: ["08:45","09:25"], 3: ["09:40","10:20"], 4: ["10:35","11:15"],
  5: ["11:30","12:10"], 6: ["12:15","12:55"], 7: ["13:10","13:50"], 8: ["13:55","14:35"],
  9: ["14:40","15:20"]
};
export const BELLS_30_OTH = {
  1: ["08:00","08:30"], 2: ["08:35","09:05"], 3: ["09:15","09:45"], 4: ["09:55","10:25"],
  5: ["10:35","11:05"], 6: ["11:10","11:40"], 7: ["11:50","12:20"], 8: ["12:25","12:55"],
  9: ["13:05","13:35"]
};

export const escapeHtml = (v) =>
  String(v == null ? "" : v).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));

export const shortDate = (iso) => {
  if (!iso) return "";
  const p = String(iso).slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}.${p[1]}` : String(iso);
};

/** Локальная дата в формате YYYY-MM-DD (без сдвига часового пояса). */
export function localIsoDate(dateObj = new Date()) {
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, "0");
  const day = String(dateObj.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Разбор YYYY-MM-DD как локальной даты (а не UTC). */
export function parseIsoDate(iso) {
  const parts = String(iso || "").slice(0, 10).split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

export function addDaysIso(iso, days) {
  const date = parseIsoDate(iso);
  if (!date) return "";
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}

/** Понедельник недели, к которой относится дата. */
export function weekStartIso(iso) {
  const date = parseIsoDate(iso);
  if (!date) return "";
  const shift = (date.getDay() + 6) % 7; // понедельник = 0
  date.setDate(date.getDate() - shift);
  return localIsoDate(date);
}

export function capitalize(text) {
  const value = String(text || "");
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export const prettyDateTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", {
    day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  });
};

/** Точка или прочерк в журнале — это долг, а не числовая отметка. */
export function isDebtMark(value) {
  const s = String(value == null ? "" : value).trim();
  return s === "." || s === "-";
}

/** «Разговоры о важном» — только понедельник; в дневнике не показываем. */
export function isImportantTalkSubject(subject) {
  return /^разговоры?\s+о\s+важном/i.test(String(subject == null ? "" : subject).trim());
}

/**
 * Числовое значение отметки для расчётов.
 * Долг («.»/«-») по просьбе пользователя считаем как «2».
 */
export function markNumber(value, debtAs = 2) {
  const s = String(value == null ? "" : value).trim();
  if (isDebtMark(s)) return debtAs;
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function markCls(v) {
  const s = String(v || "").trim().replace(",", ".");
  if (s === "." || s === "-" || s === "0") return "m0";
  if (s === "1") return "m1";
  if (s === "2") return "m2";
  if (s === "3") return "m3";
  if (s === "4") return "m4";
  if (s === "5") return "m5";
  return "m0";
}

export function getTimeInMinutes(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(":");
  if (parts.length < 2) return 0;
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

let toastTimer = null;
export function toast(msg) {
  const n = document.querySelector("#toast");
  if (!n) return;
  n.textContent = msg;
  n.hidden = false;
  requestAnimationFrame(() => n.classList.add("is-visible"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    n.classList.remove("is-visible");
    setTimeout(() => { n.hidden = true; }, 250);
  }, 1800);
}