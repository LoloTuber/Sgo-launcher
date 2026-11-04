import { state } from './js/state.js';
import * as api from './js/api.js';
import { escapeHtml, prettyDateTime, toast } from './js/utils.js';

import { renderHeader } from './js/views/header.js';
import { renderHomework } from './js/views/homework.js';
import { renderDiary } from './js/views/diary.js';
import { renderScheduleData, updateScheduleStatus } from './js/views/schedule.js';
import { renderGrades, renderResults, renderAttendance } from './js/views/grades.js';
import { renderCalculator } from './js/views/calculator.js';

// --- Надёжное хранилище: localStorage + мосты PyWebView/Android ---
// localStorage может быть недоступен (private_mode, file://, смена порта).
// Пишем параллельно в localStorage и нативный мост, читаем с приоритетом
// нативного значения, если localStorage пуст.
async function storageGet(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
  } catch (_) { /* localStorage недоступен */ }
  try {
    if (window.pywebview?.api?.get_setting) {
      return await window.pywebview.api.get_setting(key);
    }
  } catch (_) { /* мост недоступен */ }
  try {
    if (window.AndroidSettings?.get) {
      return window.AndroidSettings.get(key);
    }
  } catch (_) { /* мост недоступен */ }
  return null;
}

async function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* ignore */ }
  try {
    if (window.pywebview?.api?.set_setting) {
      await window.pywebview.api.set_setting(key, value);
    }
  } catch (_) { /* ignore */ }
  try {
    if (window.AndroidSettings?.set) {
      window.AndroidSettings.set(key, value);
    }
  } catch (_) { /* ignore */ }
}

// --- Тема ---
const COLOR_THEMES = ["blue", "pink", "purple", "orange", "red", "teal", "cyan", "slate"];

function applyColorTheme(theme) {
  document.body.classList.remove(...COLOR_THEMES.map(t => `theme-${t}`));
  if (theme && theme !== "green") {
    document.body.classList.add(`theme-${theme}`);
  }
}

function initTheme() {
  // 1. Мгновенно применяем из localStorage (синхронно, без мигания).
  const isDark = localStorage.getItem("sgo.theme") === "dark";
  if (isDark) {
    document.body.classList.add("dark-theme");
    const icon = document.querySelector("#theme-icon");
    if (icon) icon.textContent = "☀️";
  }
  applyColorTheme(localStorage.getItem("sgo.colorTheme") || "green");

  // 2. Асинхронно сверяемся с нативным хранилищем (актуально при private_mode
  //    или смене порта). Если нативное значение отличается — применяем его.
  reconcileFromNative();
}

let _reconcileDone = false;
async function reconcileFromNative() {
  if (_reconcileDone) return;
  try {
    const [theme, color] = await Promise.all([
      storageGet("sgo.theme"),
      storageGet("sgo.colorTheme"),
    ]);
    if (!theme && !color) return;
    _reconcileDone = true;

    const localTheme = localStorage.getItem("sgo.theme");
    if (theme && theme !== localTheme) {
      const isDark = theme === "dark";
      document.body.classList.toggle("dark-theme", isDark);
      const icon = document.querySelector("#theme-icon");
      if (icon) icon.textContent = isDark ? "☀️" : "🌙";
      try { localStorage.setItem("sgo.theme", theme); } catch (_) {}
    }

    const localColor = localStorage.getItem("sgo.colorTheme") || "green";
    if (color && color !== localColor) {
      applyColorTheme(color);
      try { localStorage.setItem("sgo.colorTheme", color); } catch (_) {}
      const sel = document.querySelector("#color-theme-select");
      if (sel) sel.value = color;
    }
  } catch (e) {
    console.warn("reconcileFromNative failed:", e);
  }
}

function toggleTheme() {
  const isDark = document.body.classList.toggle("dark-theme");
  const icon = document.querySelector("#theme-icon");
  if (icon) icon.textContent = isDark ? "☀️" : "🌙";
  storageSet("sgo.theme", isDark ? "dark" : "light");
}

// --- Настройки (скрытие вкладок + цветовая тема) ---
function initSettings() {
  const modal = document.querySelector("#settings-modal");
  const btn = document.querySelector("#settings-btn");
  const closeBtn = document.querySelector("#close-settings");

  btn.addEventListener("click", () => { modal.hidden = false; });
  closeBtn.addEventListener("click", () => { modal.hidden = true; });

  // --- ВЫБОР ЦВЕТОВОЙ ТЕМЫ ---
  const colorSelect = document.querySelector("#color-theme-select");
  if (colorSelect) {
    colorSelect.value = localStorage.getItem("sgo.colorTheme") || "green";

    colorSelect.addEventListener("change", () => {
      const value = colorSelect.value;
      storageSet("sgo.colorTheme", value);
      applyColorTheme(value);
      toast("Тема применена");
    });

    // Если localStorage был потерян (private_mode/смена порта) — подтягиваем
    // актуальное значение из нативного хранилища и обновляем select.
    storageGet("sgo.colorTheme").then(v => {
      if (v && colorSelect.value !== v) {
        colorSelect.value = v;
        applyColorTheme(v);
      }
    });
  }

  // --- ОБРАБОТЧИК ВЫХОДА ---
  const logoutBtn = document.querySelector("#logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      if (!confirm("Вы уверены, что хотите выйти из аккаунта?")) return;

      try {
        await fetch('/api/logout', { method: 'POST' });

        state.quick = null;
        state.grades = null;
        state.results = null;
        state.diary = null;
        state.schedule = null;
        localStorage.removeItem("sgo.term");

        modal.hidden = true;
        document.querySelector("#login-pass").value = "";
        showLogin();
      } catch (e) {
        alert("Ошибка при выходе из аккаунта");
      }
    });
  }

  const toggles = document.querySelectorAll(".tab-toggle");
  const hiddenTabs = JSON.parse(localStorage.getItem("sgo.hiddenTabs")) || [];

  toggles.forEach(t => {
    if (hiddenTabs.includes(t.value)) {
      t.checked = false;
    }

    const tabBtn = document.querySelector(`.tab[data-tab="${t.value}"]`);
    if (tabBtn) tabBtn.style.display = t.checked ? "" : "none";

    t.addEventListener("change", () => {
      const currentHidden = JSON.parse(localStorage.getItem("sgo.hiddenTabs")) || [];
      let newHidden;

      if (t.checked) {
        newHidden = currentHidden.filter(id => id !== t.value);
      } else {
        newHidden = [...currentHidden, t.value];
      }

      localStorage.setItem("sgo.hiddenTabs", JSON.stringify(newHidden));
      if (tabBtn) tabBtn.style.display = t.checked ? "" : "none";

      if (!t.checked && state.tab === t.value) {
        selectTab("homework");
      }
    });
  });
}

// --- Загрузка данных ---
async function loadQuick(force) {
  if (state.quickPromise && !force) return state.quickPromise;
  state.quickPromise = api.getQuick()
    .then((data) => {
      state.quick = data;
      renderHeader(data.student);
      renderHomework(data.homework);
      renderResults(data.results);
      document.querySelector("#updated").textContent = `Обновлено: ${prettyDateTime(data.updated)}`;
      return data;
    })
    .catch((err) => {
      document.querySelector("#banner").textContent = err.message;
      document.querySelector("#banner").hidden = false;
      document.querySelector("#hw-list").innerHTML = `<div class="empty"><strong>Не удалось загрузить</strong>${escapeHtml(err.message)}</div>`;
      throw err;
    })
    .finally(() => { state.quickPromise = null; });
  return state.quickPromise;
}

function loadGrades(force) {
  if (state.gradesPromise && !force) return state.gradesPromise;
  const list = document.querySelector("#grades-list");
  if (!state.grades) {
    list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
  }
  const term = document.querySelector("#term-select").value || "";

  state.gradesPromise = api.getGrades(term)
    .then((data) => {
      state.grades = data;
      renderGrades(data);
      renderAttendance(data);
      renderCalculator(data);
      return data;
    })
    .catch((err) => {
      const b = document.querySelector("#banner");
      b.textContent = `${err.message}\nОценки могут быть неполными.`;
      b.hidden = false;
      if (!state.grades) {
        list.innerHTML = `<div class="empty"><strong>Оценки недоступны</strong>${escapeHtml(err.message)}</div>`;
      }
      return null;
    })
    .finally(() => { state.gradesPromise = null; });
  return state.gradesPromise;
}

function loadDiary(weekIso) {
  const list = document.querySelector("#diary-list");
  list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;

  state.diaryPromise = api.getDiary(weekIso)
    .then((data) => {
      state.diary = data;
      state.currentWeek = data.weekStart;
      renderDiary(data);
      return data;
    })
    .catch((err) => {
      list.innerHTML = `<div class="empty"><strong>Ошибка дневника</strong>${escapeHtml(err.message)}</div>`;
    });
  return state.diaryPromise;
}

function loadSchedule(weekIso) {
  const list = document.querySelector("#schedule-content");
  list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;

  state.schedulePromise = api.getSchedule(weekIso)
    .then((data) => {
      state.schedule = data;
      state.scheduleWeek = data.weekStart;
      renderScheduleData(data);
      return data;
    })
    .catch((err) => {
      list.innerHTML = `<div class="empty"><strong>Ошибка расписания</strong>${escapeHtml(err.message)}</div>`;
    });
  return state.schedulePromise;
}

function refreshAll() {
  const btn = document.querySelector("#refresh");
  btn.classList.add("is-busy");
  document.querySelector("#banner").hidden = true;
  state.grades = null;
  state.results = null;

  api.postRefresh()
    .then(() => Promise.allSettled([
      loadQuick(true),
      loadGrades(true),
      loadResults(true),
      loadDiary(state.currentWeek),
      loadSchedule(state.scheduleWeek)
    ]))
    .finally(() => {
      btn.classList.remove("is-busy");
      toast("Данные обновлены");
    });
}

// --- Копирование ДЗ ---
function homeworkAsText() {
  const hw = state.quick && state.quick.homework;
  if (!hw) return "";
  const lines = [`Домашнее задание на ${hw.label}`, ""];
  if (!hw.lessons.length) lines.push("Уроков нет.");
  hw.lessons.forEach((l) => {
    const time = l.start ? ` (${l.start}${l.end ? "–" + l.end : ""})` : "";
    lines.push(`${l.number}. ${l.subject}${time}`);
    if (!l.tasks.length) lines.push("   — задания нет");
    l.tasks.forEach((t) => {
      if (t.text) lines.push(`   • ${t.text}`);
      (t.details || []).forEach((d) => {
        const label = t.details_label ? `${t.details_label}: ` : "";
        lines.push(`     ${label}${d}`);
      });
      (t.files || []).forEach((f) => lines.push(`     файл: ${f}`));
    });
    lines.push("");
  });
  return lines.join("\n").trim();
}

async function copyHomework() {
  const text = homeworkAsText();
  if (!text) { toast("Нечего копировать"); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast("ДЗ скопировано");
  } catch (e) {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      toast("ДЗ скопировано");
    } catch (_) {
      toast("Не удалось скопировать");
    } finally {
      document.body.removeChild(area);
    }
  }
}

// --- Вкладки и Термины ---
const TERM_SELECTORS = ["#term-select", "#term-select-att", "#term-select-results"];

async function loadTerms() {
  try {
    const data = await api.fetchJson("/api/terms");
    const terms = data.terms || [];
    const saved = localStorage.getItem("sgo.term") || "";
    for (const sel of TERM_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      el.innerHTML = "";
      for (const t of terms) {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.name;
        if (t.id === saved) opt.selected = true;
        el.appendChild(opt);
      }
      if (!el.value && terms.length) {
        el.value = terms[terms.length - 1].id;
      }
    }
  } catch (e) { /* ignore */ }
}

function syncTermSelectors(source) {
  for (const sel of TERM_SELECTORS) {
    if (sel === `#${source.id}`) continue;
    const target = document.querySelector(sel);
    if (target && target.value !== source.value) target.value = source.value;
  }
}

function bindTermSelectors() {
  for (const sel of TERM_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    el.addEventListener("change", () => {
      localStorage.setItem("sgo.term", el.value);
      syncTermSelectors(el);
      state.grades = null;
      state.results = null;          // ← сбрасываем старый результат
      state.resultsPromise = null;   // ← и старый промис
      loadGrades(true);
      if (sel === "#term-select-results" || sel === "#term-select") loadResults(true);
    });
  }
}

// --- Итоги: выбор триместра или годовая оценка ---
function resultsParams() {
  const termEl = document.querySelector("#term-select-results");
  const modeEl = document.querySelector("#results-mode-select");
  const mode = modeEl && modeEl.value === "year" ? "year" : "current";
  // Годовые отметки берутся из отчёта за весь год — период не важен.
  const term = mode === "year" ? "" : (termEl ? termEl.value : "");
  return { term, mode };
}

function loadResults(force) {
  const list = document.querySelector("#results-list");
  if (!list) return Promise.resolve(null);
<<<<<<< Updated upstream
=======

  // При смене терма/режима (force=true) обязательно сбрасываем старые
  // данные и промис — иначе при ошибке/пустом ответе пользователь видит
  // прошлый триместр и думает, что ничего не поменялось.
  if (force) {
    state.resultsPromise = null;
    state.results = null;
  }

>>>>>>> Stashed changes
  if (state.resultsPromise && !force) return state.resultsPromise;
  if (!state.results) {
    list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
  }
  const { term, mode } = resultsParams();

  state.resultsPromise = api.getResults(term, mode)
    .then((data) => {
      state.results = data;
      renderResults(data);
      return data;
    })
    .catch((err) => {
      if (!state.results) {
        list.innerHTML = `<div class="empty"><strong>Итоги недоступны</strong>${escapeHtml(err.message)}</div>`;
      }
      return null;
    })
    .finally(() => { state.resultsPromise = null; });
  return state.resultsPromise;
}

function bindResultsControls() {
  const modeEl = document.querySelector("#results-mode-select");
  const termEl = document.querySelector("#term-select-results");
  const savedMode = localStorage.getItem("sgo.resultsMode");
  if (modeEl && savedMode) modeEl.value = savedMode;
  applyResultsMode();

  if (modeEl) {
    modeEl.addEventListener("change", () => {
      localStorage.setItem("sgo.resultsMode", modeEl.value);
      applyResultsMode();
      loadResults(true);
    });
  }
  if (termEl) {
    termEl.addEventListener("change", applyResultsMode);
  }
}

/** В режиме «годовая оценка» выбор триместра не нужен — скрываем его. */
function applyResultsMode() {
  const modeEl = document.querySelector("#results-mode-select");
  const termEl = document.querySelector("#term-select-results");
  if (!modeEl || !termEl) return;
  const isYear = modeEl.value === "year";
  termEl.style.display = isYear ? "none" : "";
  termEl.setAttribute("aria-hidden", isYear ? "true" : "false");
}

function selectTab(name) {
  state.tab = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === name));

  if (name === "grades" || name === "attendance" || name === "calc") loadGrades();
  if (name === "results") loadResults();
  if (name === "diary" && !state.diary) loadDiary();
  if (name === "schedule" && !state.schedule) loadSchedule();
  if (name === "schedule") updateScheduleStatus();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// --- Инициализация ---
async function checkAuth() {
  try {
    const res = await fetch('/api/check_auth').then(r => r.json());
    if (res.authenticated) {
      return true;
    }
  } catch (e) {
    console.error("Auth check failed", e);
  }
  return false;
}

function showLogin() {
  const overlay = document.querySelector("#login-overlay");
  overlay.hidden = false;

  const btn = document.querySelector("#login-btn");
  const err = document.querySelector("#login-error");
  btn.textContent = "Войти";
  btn.disabled = false;
  err.textContent = "";

  const passInput = document.querySelector("#login-pass");
  const passToggle = document.querySelector("#login-pass-toggle");
  passToggle.onclick = () => {
    const show = passInput.type === "password";
    passInput.type = show ? "text" : "password";
    passToggle.textContent = show ? "🙈" : "👁";
  };

  const userInput = document.querySelector("#login-user");
  const pasteBtn = document.querySelector("#login-paste");

  pasteBtn.onclick = async () => {
    let text = "";
    try {
      if (window.AndroidClipboard && window.AndroidClipboard.getText) {
        text = window.AndroidClipboard.getText();
      } else if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch (e) {
      text = "";
    }
    text = (text || "").trim();
    if (!text) {
      err.textContent = "Буфер обмена пуст";
      return;
    }
    userInput.value = text.split(/\s+/)[0];
    err.textContent = "";
  };

  btn.onclick = async () => {
    const login = document.querySelector("#login-user").value.trim();
    const pass = document.querySelector("#login-pass").value;
    const school = document.querySelector("#login-school").value.trim();

    if (!login || !pass) {
      err.textContent = "Заполните все поля";
      return;
    }

    btn.textContent = "Вход...";
    btn.disabled = true;
    err.textContent = "";

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, pass, school })
      }).then(r => r.json());

      if (res.ok) {
        overlay.hidden = true;
        loadQuick();
        loadTerms().then(() => { loadGrades(); loadResults(); });
      } else {
        let msg = res.error || "Ошибка входа";
        if (res.login) {
          msg += `\nЛогин: «${res.login}», символов в пароле: ${res.passLen}.\nПроверьте раскладку RU/EN и лишние пробелы.`;
        }
        err.textContent = msg;
        err.style.whiteSpace = "pre-line";
        btn.textContent = "Войти";
        btn.disabled = false;
      }
    } catch (e) {
      err.textContent = "Ошибка сети";
      btn.textContent = "Войти";
      btn.disabled = false;
    }
  };
}

function init() {
  initTheme();

  // PyWebView может быть ещё не готов — ждём событие pywebviewready.
  if (window.pywebview?.api) {
    reconcileFromNative();
  } else {
    window.addEventListener("pywebviewready", reconcileFromNative, { once: true });
    setTimeout(reconcileFromNative, 1500); // страховка на старые версии
  }

  initSettings();
  document.querySelector("#theme-toggle").addEventListener("click", toggleTheme);

  document.querySelector("#tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab && tab.style.display !== "none") selectTab(tab.dataset.tab);
  });

  document.querySelector("#refresh").addEventListener("click", refreshAll);
  document.querySelector("#copy").addEventListener("click", copyHomework);
  bindTermSelectors();
  bindResultsControls();

  document.querySelector("#diary-prev").addEventListener("click", () => {
    if (!state.currentWeek) return;
    const d = new Date(state.currentWeek);
    d.setDate(d.getDate() - 7);
    loadDiary(d.toISOString().slice(0, 10));
  });
  document.querySelector("#diary-next").addEventListener("click", () => {
    if (!state.currentWeek) return;
    const d = new Date(state.currentWeek);
    d.setDate(d.getDate() + 7);
    loadDiary(d.toISOString().slice(0, 10));
  });

  document.querySelectorAll(".btn-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".btn-toggle").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.isShortDay = btn.dataset.mode === "30";
      if (state.schedule) {
        renderScheduleData(state.schedule);
      }
    });
  });

  window.addEventListener("sgo:unauthorized", showLogin);

  checkAuth().then(isAuth => {
    if (isAuth) {
      loadQuick();
      loadTerms().then(() => { loadGrades(); loadResults(); });
    } else {
      showLogin();
    }
  });

  setInterval(() => {
    if (state.schedule) updateScheduleStatus();
  }, 10000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}