import { state } from './js/state.js';
import * as api from './js/api.js';
import { escapeHtml, prettyDateTime, toast, localIsoDate, weekStartIso, addDaysIso } from './js/utils.js';
import { applyUiSettings, bindSettingsControls, getSettings, syncNativeSettings, applySettingsToControls, isDeveloperMode } from './js/settings.js';
import { refreshChanges, clearChanges, markAllRead } from './js/changes.js';
import { userError } from './js/errors.js';
import { storageGet, storageSet } from './js/storage.js';
import { scheduleFromDiary, homeworkFromDiary } from './js/derive.js';

import { renderHeader, renderHeaderAverage } from './js/views/header.js';
import { renderHomework } from './js/views/homework.js';
import { renderDiary, highlightDiaryDate } from './js/views/diary.js';
import { renderScheduleData, updateScheduleStatus } from './js/views/schedule.js';
import { renderGrades, renderResults, renderAttendance } from './js/views/grades.js';
import { renderNew, initNewTab } from './js/views/new.js';
import { renderCalculator, restoreCalcState, clearCalcState } from './js/views/calculator.js';
import { renderAnalytics } from './js/views/analytics.js';
import { renderToday, updateTodayLive } from './js/views/today.js';

// --- Безопасный localStorage ---
// В приватном режиме / при жёстких настройках браузера доступ может бросать
// исключение. Тогда просто работаем без локального кэша, а не ломаем запуск.
function lsGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* ignore */ }
}
function lsRemove(key) {
  try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
}

// --- Надёжное хранилище: localStorage + мосты PyWebView/Android ---
// Живёт в js/storage.js: им же пользуется калькулятор, чтобы сохранять
// своё состояние между запусками.

// --- Кэш последних успешно загруженных данных (Stale-While-Revalidate) ---
// Данные кладём в то же надёжное хранилище, что и настройки. Префикс
// sgo.cache. позволяет одной операцией очистить всё при выходе из аккаунта.
const CACHE_PREFIX = "sgo.cache.";

function cacheStorageKey(key) {
  return `${CACHE_PREFIX}${key}`;
}

async function saveCache(key, data) {
  if (!key || data == null) return;
  // Пользователь может отключить офлайн-режим в настройках.
  if (!getSettings().cacheEnabled) return;
  try {
    // Храним дату сохранения рядом с данными, чтобы футер мог показать
    // «Данные сохранены: …», а не время последнего ответа сервера.
    const payload = { savedAt: new Date().toISOString(), data };
    await storageSet(cacheStorageKey(key), JSON.stringify(payload));
  } catch (e) {
    // Кэш — необязательная оптимизация, его сбой не должен ломать экран.
    console.warn("saveCache failed:", key, e);
  }
}

async function loadCache(key) {
  if (!key) return null;
  try {
    const raw = await storageGet(cacheStorageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    // Текущий формат: { savedAt, data }. Старый формат (просто data)
    // тоже читаем, чтобы обновление не сбрасывало уже сохранённый кэш.
    if ("savedAt" in parsed && "data" in parsed) {
      const data = parsed.data;
      if (data && typeof data === "object") {
        try {
          Object.defineProperty(data, "__cachedAt", {
            value: parsed.savedAt,
            enumerable: false,
            configurable: true,
          });
        } catch (_) { /* замороженный объект — обойдёмся без даты */ }
      }
      return data;
    }

    return parsed;
  } catch (_) {
    return null;
  }
}

/** Дата, когда снимок был положен в кэш (с запасным вариантом для старых записей). */
function cacheSavedAt(data) {
  return (data && data.__cachedAt) || (data && data.updated) || new Date().toISOString();
}

/** Удаляет все ключи кэша из localStorage и нативного хранилища. */
async function clearCache() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch (_) { /* localStorage недоступен */ }

  // На Android у моста есть remove. На PyWebView/старых сборках его может
  // не быть — тогда записываем пустую строку, чтобы кэш не прочитался снова.
  for (const key of keys) {
    try {
      if (window.pywebview?.api?.set_setting) {
        await window.pywebview.api.set_setting(key, "");
      }
    } catch (_) { /* ignore */ }
    try {
      if (window.AndroidSettings?.remove) window.AndroidSettings.remove(key);
    } catch (_) { /* ignore */ }
  }
}

const OFFLINE_MESSAGE = "⚠️ Нет соединения. Показаны сохранённые данные";

// Кэш старше этого времени считаем устаревшим и сообщаем об этом.
const CACHE_STALE_MS = 30 * 60 * 1000;

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Возраст снимка кэша в миллисекундах (null, если дату не удалось прочитать). */
function cacheAgeMs(data) {
  const saved = Date.parse(cacheSavedAt(data));
  return Number.isFinite(saved) ? Math.max(0, Date.now() - saved) : null;
}

function formatCacheAge(data) {
  const ms = cacheAgeMs(data);
  if (ms === null) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} ${plural(minutes, "минуту", "минуты", "минут")} назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, "час", "часа", "часов")} назад`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, "день", "дня", "дней")} назад`;
}

function isCacheStale(data) {
  const ms = cacheAgeMs(data);
  return ms !== null && ms >= CACHE_STALE_MS;
}

function setBanner(kind, text) {
  const banner = document.querySelector("#banner");
  if (!banner) return;
  banner.textContent = text;
  banner.hidden = false;
  banner.classList.toggle("is-info", kind === "info");
  banner.dataset.cacheNotice = kind;
}

/** Офлайн: показываем, сколько времени сохранённому снимку, если он старый. */
function showOfflineBanner(data) {
  const suffix = data && isCacheStale(data)
    ? ` (сохранены ${formatCacheAge(data)})`
    : "";
  setBanner("offline", `${OFFLINE_MESSAGE}${suffix}.`);
}

/** Онлайн, но кэш устарел: сообщаем возраст и что обновление идёт в фоне. */
function showStaleBanner(data) {
  const age = formatCacheAge(data);
  setBanner(
    "info",
    `🕓 Показаны сохранённые данные${age ? `: сохранены ${age}` : ""}. Обновляем…`
  );
}

function showErrorBanner(message) {
  const banner = document.querySelector("#banner");
  if (!banner) return;
  banner.textContent = message;
  banner.hidden = false;
  banner.classList.remove("is-info");
  delete banner.dataset.cacheNotice;
}

function clearOfflineBanner() {
  const banner = document.querySelector("#banner");
  if (!banner || !banner.dataset.cacheNotice) return;
  banner.hidden = true;
  banner.textContent = "";
  banner.classList.remove("is-info");
  delete banner.dataset.cacheNotice;
}

// --- Таймауты запросов ---
/**
 * Не даёт одному зависшему запросу заблокировать отрисовку интерфейса.
 * Сам запрос продолжается в фоне и может дорисовать данные позже.
 */
function withTimeout(promise, ms, fallback) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}


/**
 * Запуск приложения после успешного входа/проверки авторизации.
 * Порядок важен: сначала главное, затем отчёты, затем дневник и расписание.
 */
async function startApp(options = {}) {
  const useCache = options.useCache !== false;
  state.authenticated = true;
  await restoreCalcState();

  // Мгновенный путь: всё, что уже есть в кэше, показываем сразу,
  // не дожидаясь ни одного сетевого запроса.
  if (useCache && await hydrateOnce()) {
    revealCachedApp();
    return;
  }

  // Кэша нет — грузим волнами. Экрана загрузки нет: панели показывают
  // скелетоны, а прочие вкладки остаются доступными.
  try {
    await withTimeout(loadQuick(), 12000, null);
  } catch (_) {
    /* ошибка уже показана в баннере */
  }

  await withTimeout(loadTerms(), 8000, null);
  const [gradesResult, resultsResult] = await Promise.allSettled([
    withTimeout(loadGrades(true), 15000, null),
    withTimeout(loadResults(true), 15000, null),
  ]);
  const gradesOk = gradesResult.status === "fulfilled" && !!gradesResult.value;
  const resultsOk = resultsResult.status === "fulfilled" && !!resultsResult.value;

  const week = weekStartIso(localIsoDate());
  const [diaryResult, scheduleResult] = await Promise.allSettled([
    withTimeout(loadDiary(week), 15000, null),
    withTimeout(loadSchedule(week), 15000, null),
  ]);
  const diaryOk = diaryResult.status === "fulfilled" && !!diaryResult.value;
  const scheduleOk = scheduleResult.status === "fulfilled" && !!scheduleResult.value;

  // На выходных ближайший учебный день уже в следующей неделе.
  const todayIso = localIsoDate();
  const dayOfWeek = new Date().getDay();
  const todayDay = state.schedule && Array.isArray(state.schedule.days)
    ? state.schedule.days.find((day) => day.date === todayIso)
    : null;
  const todayHasLessons = !!(todayDay && (todayDay.lessons || [])
    .some((lesson) => String(lesson.subject || "").trim()));
  if (dayOfWeek === 0 || dayOfWeek === 6 || (dayOfWeek === 5 && !todayHasLessons)) {
    await withTimeout(loadNextWeekSchedule(), 12000, null);
  }

  selectTab(state.tab);
  renderToday();

  if (!(gradesOk || resultsOk) || !(diaryOk || scheduleOk)) {
    toast("Часть данных не загрузилась");
  }
}

/** Глобальное действие «Отметить всё прочитанным» из шапки. */
function markEverythingRead() {
  markAllRead();
  window.dispatchEvent(new CustomEvent("sgo:changes-read"));
  renderToday();
  toast("Отмечено прочитанным");
}

// --- Служебные сведения о сборке ---
let aboutInfo = null;

/** Текст со сведениями о сборке — для служебного режима. */
function aboutText() {
  if (!aboutInfo) return "";
  const parts = [
    `Дневник ${aboutInfo.version || "?"} (сборка ${aboutInfo.build || "?"})`,
    `Платформа: ${aboutInfo.platform || "?"}`,
  ];
  if (aboutInfo.python) parts.push(`Python ${aboutInfo.python}`);
  if (aboutInfo.dataDir) parts.push(`Данные: ${aboutInfo.dataDir}`);
  if (aboutInfo.school) parts.push(`Школа: ${aboutInfo.school}`);
  return parts.join("\n");
}

/** Подгружает сведения о сборке и показывает их в подвале и настройках. */
async function loadAboutInfo() {
  if (!isDeveloperMode()) return;
  const info = document.querySelector("#about-info");
  const version = document.querySelector("#app-version");
  try {
    const data = await api.getAbout();
    aboutInfo = data;
    if (info) info.textContent = aboutText();
    if (version) version.textContent = `Версия ${data.version || "?"}`;
  } catch (e) {
    if (info) info.textContent = "Сведения о сборке недоступны.";
  }
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
  const isDark = lsGet("sgo.theme") === "dark";
  if (isDark) {
    document.body.classList.add("dark-theme");
    const icon = document.querySelector("#theme-icon");
    if (icon) icon.textContent = "☀️";
  }
  applyColorTheme(lsGet("sgo.colorTheme") || "green");

  // 2. Асинхронно сверяемся с нативным хранилищем (актуально при private_mode
  //    или смене порта). Если нативное значение отличается — применяем его.
  reconcileFromNative();
}

let _reconcileDone = false;
async function reconcileFromNative() {
  if (_reconcileDone) return;
  try {
    // Настройки фонового режима могли быть изменены нативно:
    // переключателем в трее (ПК) или сервисом (Android). Нативное значение главное.
    try {
      if (await syncNativeSettings()) {
        applySettingsToControls();
        applyUiSettings();
      }
    } catch (e) { /* нативное хранилище недоступно */ }

    const [theme, color] = await Promise.all([
      storageGet("sgo.theme"),
      storageGet("sgo.colorTheme"),
    ]);
    if (!theme && !color) return;
    _reconcileDone = true;

    const localTheme = lsGet("sgo.theme");
    if (theme && theme !== localTheme) {
      const isDark = theme === "dark";
      document.body.classList.toggle("dark-theme", isDark);
      const icon = document.querySelector("#theme-icon");
      if (icon) icon.textContent = isDark ? "☀️" : "🌙";
      lsSet("sgo.theme", theme);
    }

    const localColor = lsGet("sgo.colorTheme") || "green";
    if (color && color !== localColor) {
      applyColorTheme(color);
      lsSet("sgo.colorTheme", color);
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

/**
 * Включает/выключает автозапуск вместе с Windows.
 *
 * На Android такого нет — там просто ничего не делаем.
 */
async function notifyAutostart(enabled) {
  try {
    if (window.pywebview?.api?.set_autostart) {
      await window.pywebview.api.set_autostart(enabled);
      toast(enabled ? "Автозапуск включён" : "Автозапуск выключен");
      return;
    }
  } catch (e) {
    console.warn("Не удалось изменить автозапуск:", e);
  }
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
    colorSelect.value = lsGet("sgo.colorTheme") || "green";

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

        // Данные предыдущего аккаунта не должны оставаться на устройстве.
        await clearCache();
        await clearCalcState();
        hydratePromise = null;
        appRevealed = false;
        clearOfflineBanner();
        quickRequestId += 1;
        gradesRequestId += 1;
        resultsRequestId += 1;
        diaryRequestId += 1;
        scheduleRequestId += 1;

        state.quick = null;
        state.grades = null;
        state.results = null;
        state.diary = null;
        state.schedule = null;
        state.nextSchedule = null;
        state.quickPromise = null;
        state.gradesPromise = null;
        state.resultsPromise = null;
        state.diaryPromise = null;
        state.schedulePromise = null;
        state.currentWeek = null;
        state.scheduleWeek = null;
        state.authenticated = false;
        state.calcTerm = null;
        state.simAdjustments = {};
        state.simAdded = [];
        clearChanges();
        lsRemove("sgo.term");

        modal.hidden = true;
        document.querySelector("#login-pass").value = "";
        showLogin();
      } catch (e) {
        alert("Ошибка при выходе из аккаунта");
      }
    });
  }

  const toggles = Array.from(document.querySelectorAll(".tab-toggle"));
  let hiddenTabs = [];
  try {
    const parsed = JSON.parse(lsGet("sgo.hiddenTabs") || "[]");
    if (Array.isArray(parsed)) hiddenTabs = parsed;
  } catch (_) { /* повреждённое значение — игнорируем */ }

  toggles.forEach(t => {
    if (hiddenTabs.includes(t.value)) {
      t.checked = false;
    }

    const tabBtn = document.querySelector(`.tab[data-tab="${t.value}"]`);
    if (tabBtn) tabBtn.style.display = t.checked ? "" : "none";

    t.addEventListener("change", () => {
      // Не даём скрыть последнюю видимую вкладку — иначе экран опустеет.
      if (!t.checked && !toggles.some(other => other.checked)) {
        t.checked = true;
        toast("Должна остаться хотя бы одна вкладка");
        return;
      }

      let currentHidden = [];
      try {
        const parsed = JSON.parse(lsGet("sgo.hiddenTabs") || "[]");
        if (Array.isArray(parsed)) currentHidden = parsed;
      } catch (_) { /* ignore */ }

      let newHidden;
      if (t.checked) {
        newHidden = currentHidden.filter(id => id !== t.value);
      } else {
        newHidden = [...currentHidden, t.value];
      }

      lsSet("sgo.hiddenTabs", JSON.stringify(newHidden));
      if (tabBtn) tabBtn.style.display = t.checked ? "" : "none";

      if (!t.checked && state.tab === t.value) {
        ensureVisibleTab();
      }
    });
  });

  // Новые настройки вида: применяем сразу и перерисовываем зависимые экраны.
  bindSettingsControls((name) => {
    if (name === "hideEmptyLessons") {
      if (state.diary) renderDiary(state.diary);
      if (state.schedule) renderScheduleData(state.schedule);
    } else if (name === "todayOnly") {
      if (state.schedule) renderScheduleData(state.schedule);
    } else if (name === "autostart") {
      // Автозапуск включает/выключает нативная часть — сообщаем ей.
      notifyAutostart(!!getSettings().autostart);
    } else if (name === "developerMode") {
      loadAboutInfo();
    }
    if (state.tab === "today") renderToday();
  });

  // Автозапуск есть только в версии для компьютера.
  const autostartRow = document.querySelector("#setting-autostart-row");
  const autostartHint = document.querySelector("#setting-autostart-hint");
  const isDesktop = !!window.pywebview?.api;
  if (!isDesktop && autostartRow) autostartRow.hidden = true;
  if (!isDesktop && autostartHint) autostartHint.hidden = false;

  // Нативная часть (трей на ПК, сервис на Android) могла поменять настройки —
  // подхватываем их и обновляем окно настроек.
  window.addEventListener("sgo:sync-settings", async () => {
    const changed = await syncNativeSettings();
    if (changed) {
      applySettingsToControls();
      applyUiSettings();
    }
  });

  // Фоновая проверка нашла новое — тихо обновляем открытые экраны.
  window.addEventListener("sgo:data-updated", () => {
    if (!state.authenticated) return;
    loadDiary();
    loadGrades(true);
    loadQuick(true);
  });

  // --- СОХРАНЕНИЕ ДАННЫХ ---
  const clearCacheBtn = document.querySelector("#clear-cache-btn");
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener("click", async () => {
      await clearCache();
      toast("Сохранённые данные очищены");
    });
  }

  const clearChangesBtn = document.querySelector("#clear-changes-btn");
  if (clearChangesBtn) {
    clearChangesBtn.addEventListener("click", () => {
      clearChanges();
      toast("Отметки «новое» сброшены");
    });
  }

  // Служебные сведения о сборке — только в служебном режиме.
  const copyAboutBtn = document.querySelector("#copy-about-btn");
  if (copyAboutBtn) {
    copyAboutBtn.addEventListener("click", async () => {
      const text = aboutText();
      if (!text) { toast("Сведения недоступны"); return; }
      try {
        await navigator.clipboard.writeText(text);
        toast("Сведения скопированы");
      } catch (e) {
        toast("Не удалось скопировать");
      }
    });
  }
  if (isDeveloperMode()) loadAboutInfo();

  // Если сохранённая активная вкладка скрыта — открываем первую видимую.
  ensureVisibleTab();
}

function ensureVisibleTab() {
  const active = document.querySelector(".tab.is-active");
  if (active && active.style.display !== "none") return;

  const allTabs = Array.from(document.querySelectorAll(".tab"));
  let firstVisible = allTabs.find(tab => tab.style.display !== "none");

  // Совсем все вкладки скрыты (например, повреждённые настройки) —
  // принудительно показываем первую.
  if (!firstVisible && allTabs.length) {
    firstVisible = allTabs[0];
    firstVisible.style.display = "";
    const toggle = document.querySelector(`.tab-toggle[value="${firstVisible.dataset.tab}"]`);
    if (toggle) toggle.checked = true;
  }

  if (firstVisible) selectTab(firstVisible.dataset.tab);
}

// --- Загрузка данных ---
// Все экраны работают по схеме Stale-While-Revalidate:
//   1) мгновенно показываем кэш (если он есть);
//   2) запрашиваем свежие данные;
//   3) обновляем экран и перезаписываем кэш.
// При сетевой ошибке кэш остаётся на экране, а сверху появляется баннер.

const gradesCacheKey = (term) => `grades.${term || "current"}`;
const resultsCacheKey = (term, mode) => `results.${mode}.${term || "year"}`;
const diaryCacheKey = (week) => `diary.${week || "current"}`;
const scheduleCacheKey = (week) => `schedule.${week || "current"}`;

/**
 * Догружаем то, чего не хватило, из дневника.
 *
 * В дневнике уже есть уроки, домашнее задание и отметки. Поэтому, если
 * отдельный запрос не прошёл (сервер не ответил или вкладку не открывали),
 * расписание и ДЗ можно показать из дневника, а новые оценки — посчитать
 * по его отметкам.
 */
function applyDiaryDerived() {
  const diary = state.diary;
  if (!diary) return false;
  let changed = false;

  if (!state.schedule) {
    const derived = scheduleFromDiary(diary);
    if (derived) {
      state.schedule = derived;
      state.scheduleWeek = derived.weekStart;
      renderScheduleData(derived);
      changed = true;
    }
  }

  if (!state.quick || !state.quick.homework) {
    const homework = homeworkFromDiary(diary, addDaysIso(localIsoDate(), 1));
    if (homework) {
      renderHomework(homework);
      changed = true;
    }
  }

  return changed;
}

function renderQuickData(data, fromCache = false) {
  state.quick = data;
  refreshChanges();
  renderHeader(data.student);
  renderHomework(data.homework);
  renderResults(data.results);
  if (state.tab === "today") renderToday();
  const updated = document.querySelector("#updated");
  if (updated) {
    updated.textContent = fromCache
      ? `Данные сохранены: ${prettyDateTime(cacheSavedAt(data))}`
      : `Обновлено: ${prettyDateTime(data.updated)}`;
  }
}

function renderGradesData(data) {
  state.grades = data;
  refreshChanges();
  renderHeaderAverage();
  renderGrades(data);
  renderAttendance(data);
  renderAnalytics(data);
  renderCalculator(data);
  if (state.tab === "today") renderToday();
}

let quickRequestId = 0;
let gradesRequestId = 0;
let resultsRequestId = 0;
let diaryRequestId = 0;
let scheduleRequestId = 0;

function loadQuick(force) {
  if (state.quickPromise && !force) return state.quickPromise;
  const requestId = ++quickRequestId;

  const promise = (async () => {
    let cached = null;
    if (!state.quick) {
      cached = await loadCache("quick");
      if (requestId !== quickRequestId) return null;
      // Проверяем минимальную форму ответа, чтобы старый/битый кэш
      // не уронил рендер. Если форма не та — просто идём в сеть.
      if (!cached || !cached.homework || !cached.student) cached = null;
      if (cached) renderQuickData(cached, true);
    }

    try {
      const data = await api.getQuick();
      await saveCache("quick", data);
      if (requestId !== quickRequestId) return null;
      renderQuickData(data);
      clearOfflineBanner();
      return data;
    } catch (err) {
      if (requestId !== quickRequestId) return null;
      if (state.quick || cached) {
        showOfflineBanner(state.quick || cached);
        return state.quick || cached;
      }
      // «Быстрых» данных нет — ДЗ и расписание берём из дневника.
      if (applyDiaryDerived()) {
        showOfflineBanner(state.diary);
        return null;
      }
      showErrorBanner(userError(err.message));
      const hwList = document.querySelector("#hw-list");
      if (hwList) {
        hwList.innerHTML = `<div class="empty"><strong>Не удалось загрузить</strong>${escapeHtml(userError(err.message))}</div>`;
      }
      throw err;
    }
  })();

  state.quickPromise = promise;
  const reset = () => {
    if (state.quickPromise === promise) state.quickPromise = null;
  };
  promise.then(reset, reset);
  return promise;
}

function loadGrades(force) {
  if (state.gradesPromise && !force) return state.gradesPromise;

  const list = document.querySelector("#grades-list");
  const term = document.querySelector("#term-select").value || "";
  const cacheKey = gradesCacheKey(term);
  const requestId = ++gradesRequestId;

  const promise = (async () => {
    let cached = null;
    if (!state.grades) {
      cached = await loadCache(cacheKey);
      if (requestId !== gradesRequestId) return null;
      // Если период ещё неизвестен (список периодов не загрузился),
      // показываем последний сохранённый снимок оценок.
      if (!cached && !term) {
        const latest = await loadCache("grades.latest");
        if (requestId !== gradesRequestId) return null;
        if (latest && latest.data) cached = latest.data;
      }
      if (cached) {
        renderGradesData(cached);
      } else if (list) {
        list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
      }
    }

    try {
      const data = await api.getGrades(term);
      await saveCache(cacheKey, data);
      await saveCache("grades.latest", { termId: term, data });
      if (requestId !== gradesRequestId) return null;
      renderGradesData(data);
      clearOfflineBanner();
      return data;
    } catch (err) {
      if (requestId !== gradesRequestId) return null;
      if (state.grades || cached) {
        showOfflineBanner(state.quick || state.grades || cached);
        return state.grades || cached;
      }
      showErrorBanner(userError(`${err.message}\nОценки могут быть неполными.`));
      if (list) {
        list.innerHTML = `<div class="empty"><strong>Оценки недоступны</strong>${escapeHtml(userError(err.message))}</div>`;
      }
      return null;
    }
  })();

  state.gradesPromise = promise;
  const reset = () => {
    if (state.gradesPromise === promise) state.gradesPromise = null;
  };
  promise.then(reset, reset);
  return promise;
}

/**
 * Загружает дневник за неделю.
 *
 * options.force = true — читать неделю заново, а не брать предзагруженную
 * копию (так работает переход на следующую неделю).
 */
function loadDiary(weekIso, options = {}) {
  const cacheWeek = weekStartIso(weekIso || localIsoDate()) || weekIso || "current";
  const cacheKey = diaryCacheKey(cacheWeek);
  const list = document.querySelector("#diary-list");
  const requestId = ++diaryRequestId;

  const promise = (async () => {
    let cached = null;
    if (!state.diary || state.diary.weekStart !== cacheWeek) {
      cached = await loadCache(cacheKey);
      if (requestId !== diaryRequestId) return null;
      if (cached) {
        state.diary = cached;
        state.currentWeek = cached.weekStart || cacheWeek;
        refreshChanges();
        renderDiary(cached);
        if (state.tab === "today") renderToday();
      } else if (list) {
        list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
      }
    }

    try {
      const data = await api.getDiary(weekIso, !!options.force);
      await saveCache(diaryCacheKey(data.weekStart || cacheWeek), data);
      if (requestId !== diaryRequestId) return null;
      state.diary = data;
      state.currentWeek = data.weekStart;
      refreshChanges();
      renderDiary(data);
      applyDiaryDerived();
      if (state.tab === "today") renderToday();
      clearOfflineBanner();
      return data;
    } catch (err) {
      if (requestId !== diaryRequestId) return null;
      const hasCurrent = state.diary && state.diary.weekStart === cacheWeek;
      if (cached || hasCurrent) {
        showOfflineBanner(state.quick || state.diary || cached);
        return state.diary || cached;
      }
      if (list) {
        list.innerHTML = `<div class="empty"><strong>Ошибка дневника</strong>${escapeHtml(userError(err.message))}</div>`;
      }
      return null;
    }
  })();

  state.diaryPromise = promise;
  const reset = () => {
    if (state.diaryPromise === promise) state.diaryPromise = null;
  };
  promise.then(reset, reset);
  return promise;
}

function loadSchedule(weekIso) {
  const cacheWeek = weekStartIso(weekIso || localIsoDate()) || weekIso || "current";
  const cacheKey = scheduleCacheKey(cacheWeek);
  const list = document.querySelector("#schedule-content");
  const requestId = ++scheduleRequestId;

  const promise = (async () => {
    let cached = null;
    if (!state.schedule || state.schedule.weekStart !== cacheWeek) {
      cached = await loadCache(cacheKey);
      if (requestId !== scheduleRequestId) return null;
      if (cached) {
        state.schedule = cached;
        state.scheduleWeek = cached.weekStart || cacheWeek;
        refreshChanges();
        renderScheduleData(cached);
        if (state.tab === "today") renderToday();
      } else if (list) {
        list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
      }
    }

    try {
      const data = await api.getSchedule(weekIso);
      await saveCache(scheduleCacheKey(data.weekStart || cacheWeek), data);
      if (requestId !== scheduleRequestId) return null;
      state.schedule = data;
      state.scheduleWeek = data.weekStart;
      refreshChanges();
      renderScheduleData(data);
      if (state.tab === "today") renderToday();
      clearOfflineBanner();
      return data;
    } catch (err) {
      if (requestId !== scheduleRequestId) return null;
      const hasCurrent = state.schedule && state.schedule.weekStart === cacheWeek;
      if (cached || hasCurrent) {
        showOfflineBanner(state.quick || state.schedule || cached);
        return state.schedule || cached;
      }
      // Расписание не пришло — покажем уроки из дневника, если он есть.
      if (applyDiaryDerived()) {
        showOfflineBanner(state.quick || state.diary);
        return state.schedule;
      }
      if (list) {
        list.innerHTML = `<div class="empty"><strong>Ошибка расписания</strong>${escapeHtml(userError(err.message))}</div>`;
      }
      return null;
    }
  })();

  state.schedulePromise = promise;
  const reset = () => {
    if (state.schedulePromise === promise) state.schedulePromise = null;
  };
  promise.then(reset, reset);
  return promise;
}

/**
 * Догружает расписание следующей недели. Нужно на выходных, когда
 * ближайший учебный день уже не входит в текущую неделю.
 */
async function loadNextWeekSchedule() {
  const nextWeek = addDaysIso(weekStartIso(localIsoDate()), 7);
  const cacheKey = scheduleCacheKey(nextWeek);

  let cached = await loadCache(cacheKey);
  if (cached && cached.weekStart === nextWeek) {
    state.nextSchedule = cached;
  }

  try {
    const data = await api.getSchedule(nextWeek);
    await saveCache(scheduleCacheKey(data.weekStart || nextWeek), data);
    state.nextSchedule = data;
    return data;
  } catch (err) {
    if (state.nextSchedule) {
      showOfflineBanner(state.quick || state.nextSchedule);
      return state.nextSchedule;
    }
    return null;
  }
}

/**
 * Читает кэш всех разделов и сразу отрисовывает их, не трогая сеть.
 * Возвращает true, если удалось показать хотя бы часть данных.
 */
async function hydrateFromCache() {
  const week = weekStartIso(localIsoDate());
  const nextWeek = addDaysIso(week, 7);

  // Симуляция калькулятора тоже должна пережить перезапуск.
  await restoreCalcState();

  // Список периодов нужен до оценок: от него зависит ключ кэша.
  const termsCache = await loadCache("terms");
  const terms = termsCache && Array.isArray(termsCache.terms) ? termsCache.terms : [];
  if (terms.length) applyTerms(terms);

  const termEl = document.querySelector("#term-select");
  const term = termEl ? termEl.value : "";
  const resultsModeEl = document.querySelector("#results-mode-select");
  const resultsMode = resultsModeEl && resultsModeEl.value === "year" ? "year" : "current";
  const resultsTerm = resultsMode === "year" ? "" : term;

  const [quick, grades, gradesLatest, results, resultsLatest, diary, schedule, nextSchedule] =
    await Promise.all([
      loadCache("quick"),
      loadCache(gradesCacheKey(term)),
      loadCache("grades.latest"),
      loadCache(resultsCacheKey(resultsTerm, resultsMode)),
      loadCache(`results.latest.${resultsMode}`),
      loadCache(diaryCacheKey(week)),
      loadCache(scheduleCacheKey(week)),
      loadCache(scheduleCacheKey(nextWeek)),
    ]);

  let hasAny = false;

  // Каждый блок отдельно: битый снимок не должен скрыть остальные.
  if (quick && quick.student && quick.homework) {
    try {
      renderQuickData(quick, true);
      hasAny = true;
    } catch (e) {
      console.warn("Не удалось восстановить главное из кэша", e);
    }
  }

  const gradesData = grades || (gradesLatest && gradesLatest.data);
  if (gradesData) {
    try {
      renderGradesData(gradesData);
      hasAny = true;
    } catch (e) {
      console.warn("Не удалось восстановить оценки из кэша", e);
    }
  }

  const resultsData = results || (resultsLatest && resultsLatest.data);
  if (resultsData) {
    try {
      state.results = resultsData;
      renderResults(resultsData);
      hasAny = true;
    } catch (e) {
      console.warn("Не удалось восстановить итоги из кэша", e);
    }
  }

  if (diary && Array.isArray(diary.days)) {
    try {
      state.diary = diary;
      state.currentWeek = diary.weekStart || week;
      refreshChanges();
      renderDiary(diary);
      hasAny = true;
    } catch (e) {
      console.warn("Не удалось восстановить дневник из кэша", e);
    }
  }

  if (schedule && Array.isArray(schedule.days)) {
    try {
      state.schedule = schedule;
      state.scheduleWeek = schedule.weekStart || week;
      refreshChanges();
      renderScheduleData(schedule);
      hasAny = true;
    } catch (e) {
      console.warn("Не удалось восстановить расписание из кэша", e);
    }
  }

  if (nextSchedule && Array.isArray(nextSchedule.days)) {
    state.nextSchedule = nextSchedule;
  }

  // Сообщение о возрасте кэша — только если он действительно старый.
  const ageSource = quick || diary || schedule;
  if (ageSource && isCacheStale(ageSource)) showStaleBanner(ageSource);

  return hasAny;
}

let hydratePromise = null;
function hydrateOnce() {
  if (!hydratePromise) hydratePromise = hydrateFromCache();
  return hydratePromise;
}

let appRevealed = false;
/** Показывает приложение с уже отрисованным кэшем и запускает фоновое обновление. */
function revealCachedApp() {
  if (appRevealed) return;
  appRevealed = true;
  state.authenticated = true;
  selectTab(state.tab);
  renderToday();
  revalidateAll();
}

/** Тихое обновление в фоне: экран уже показан, сеть ничего не блокирует. */
function revalidateAll() {
  const todayIso = localIsoDate();
  const week = weekStartIso(todayIso);
  const dayOfWeek = new Date().getDay();
  const todayDay = state.schedule && Array.isArray(state.schedule.days)
    ? state.schedule.days.find((day) => day.date === todayIso)
    : null;
  const todayHasLessons = !!(todayDay && (todayDay.lessons || [])
    .some((lesson) => String(lesson.subject || "").trim()));
  const needNextWeek = dayOfWeek === 0 || dayOfWeek === 6
    || (dayOfWeek === 5 && !todayHasLessons);

  const tasks = [];
  if (!state.quickPromise) tasks.push(loadQuick());
  if (!state.gradesPromise) tasks.push(loadGrades());
  if (!state.resultsPromise) tasks.push(loadResults());
  if (!state.diaryPromise) tasks.push(loadDiary(state.currentWeek || week));
  if (!state.schedulePromise) tasks.push(loadSchedule(state.scheduleWeek || week));
  tasks.push(loadTerms());
  if (needNextWeek) tasks.push(loadNextWeekSchedule());

  Promise.allSettled(tasks).then(() => {
    if (state.tab === "today") renderToday();
    scheduleDiaryPreload();
  });
}

let _preloadTimer = null;

/**
 * Предзагрузка соседних недель дневника.
 *
 * Делаем это последним делом и с задержкой: основные экраны должны
 * открыться быстро, а соседние недели — уже готовы к моменту,
 * когда пользователь нажмёт «Пред. неделя».
 */
function scheduleDiaryPreload(delay = 1500) {
  if (_preloadTimer) clearTimeout(_preloadTimer);
  _preloadTimer = setTimeout(() => {
    _preloadTimer = null;
    api.preloadDiary(2).catch(() => {});
  }, delay);
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
      scheduleDiaryPreload(2500);
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

/** Заполняет селекты периодов — и при загрузке из кэша, и после ответа сети. */
function applyTerms(terms) {
  if (!Array.isArray(terms) || !terms.length) return;

  const saved = lsGet("sgo.term") || "";
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
}

async function loadTerms() {
  let terms = [];
  try {
    const data = await api.fetchJson("/api/terms");
    terms = data.terms || [];
    if (terms.length) saveCache("terms", { terms });
  } catch (e) {
    // Офлайн: восстанавливаем список периодов из кэша, чтобы селекты
    // не оставались на «Загрузка…» и оценки брались по нужному ключу.
    const cached = await loadCache("terms");
    if (cached && Array.isArray(cached.terms)) terms = cached.terms;
  }

  applyTerms(terms);
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
      lsSet("sgo.term", el.value);
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

  // При смене терма/режима (force=true) обязательно сбрасываем старые
  // данные и промис — иначе при ошибке/пустом ответе пользователь видит
  // прошлый триместр и думает, что ничего не поменялось.
  if (force) {
    state.resultsPromise = null;
    state.results = null;
  }

  if (state.resultsPromise && !force) return state.resultsPromise;

  const { term, mode } = resultsParams();
  const cacheKey = resultsCacheKey(term, mode);
  const requestId = ++resultsRequestId;

  const promise = (async () => {
    let cached = null;
    if (!state.results) {
      cached = await loadCache(cacheKey);
      if (requestId !== resultsRequestId) return null;
      // Без загруженного списка периодов точный ключ может быть неизвестен.
      // В этом случае берём последний снимок для выбранного режима.
      if (!cached && !term) {
        const latest = await loadCache(`results.latest.${mode}`);
        if (requestId !== resultsRequestId) return null;
        if (latest && latest.data) cached = latest.data;
      }
      if (cached) {
        state.results = cached;
        renderResults(cached);
      } else {
        list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
      }
    }

    try {
      const data = await api.getResults(term, mode);
      await saveCache(cacheKey, data);
      await saveCache(`results.latest.${mode}`, { termId: term, data });
      if (requestId !== resultsRequestId) return null;
      state.results = data;
      renderResults(data);
      clearOfflineBanner();
      return data;
    } catch (err) {
      if (requestId !== resultsRequestId) return null;
      if (state.results || cached) {
        showOfflineBanner(state.quick || state.results || cached);
        return state.results || cached;
      }
      list.innerHTML = `<div class="empty"><strong>Итоги недоступны</strong>${escapeHtml(userError(err.message))}</div>`;
      return null;
    }
  })();

  state.resultsPromise = promise;
  const reset = () => {
    if (state.resultsPromise === promise) state.resultsPromise = null;
  };
  promise.then(reset, reset);
  return promise;
}

function bindResultsControls() {
  const modeEl = document.querySelector("#results-mode-select");
  const termEl = document.querySelector("#term-select-results");
  const savedMode = lsGet("sgo.resultsMode");
  if (modeEl && savedMode) modeEl.value = savedMode;
  applyResultsMode();

  if (modeEl) {
    modeEl.addEventListener("change", () => {
      lsSet("sgo.resultsMode", modeEl.value);
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

function ensureTodayData() {
  const thisWeek = weekStartIso(localIsoDate());
  const tasks = [];

  if (!state.quick && !state.quickPromise) tasks.push(loadQuick());
  if ((!state.diary || state.diary.weekStart !== thisWeek) && !state.diaryPromise) {
    tasks.push(loadDiary(thisWeek));
  }
  if ((!state.schedule || state.schedule.weekStart !== thisWeek) && !state.schedulePromise) {
    tasks.push(loadSchedule(thisWeek));
  }
  if (!state.grades && !state.gradesPromise) tasks.push(loadGrades());

  renderToday();

  if (tasks.length) {
    Promise.allSettled(tasks).then(() => {
      if (state.tab === "today") renderToday();
    });
  }
}

function selectTab(name) {
  state.tab = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === name));

  if (!state.authenticated) return;

  if (name === "today") ensureTodayData();
  if (name === "new") renderNew();
  if (name === "grades" || name === "attendance" || name === "calc" || name === "analytics") loadGrades();
  if (name === "results") loadResults();
  if (name === "diary" && !state.diary) loadDiary();
  if (name === "schedule" && !state.schedule) loadSchedule();
  if (name === "schedule") updateScheduleStatus();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// --- Инициализация ---
async function checkAuth() {
  const controller = new AbortController();
  // Если сервер завис (не отвечает и не рвёт соединение), не держим
  // пользователя на экране загрузки дольше трёх секунд.
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch('/api/check_auth', { signal: controller.signal }).then(r => r.json());
    if (res.authenticated) {
      return true;
    }
    // Подставляем сохранённую школу — чтобы не искать её заново.
    if (res.school) {
      const schoolInput = document.querySelector("#login-school");
      if (schoolInput) schoolInput.value = res.school;
    }
  } catch (e) {
    console.error("Auth check failed", e);
    // Офлайн-режим: если сервер недоступен, но есть сохранённые данные,
    // пускаем в приложение только на чтение вместо экрана входа.
    const cached = await loadCache("quick");
    if (cached && cached.student) return true;
  } finally {
    clearTimeout(timer);
  }
  return false;
}

function showLogin() {
  state.authenticated = false;
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

  // Школу запоминаем: после выхода из аккаунта сервер её не знает.
  // Если школа сохранена — она главнее значения по умолчанию.
  const schoolInput = document.querySelector("#login-school");
  if (schoolInput) {
    const saved = lsGet("sgo.school");
    if (saved) schoolInput.value = saved;
  }

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
        // Школу запоминаем — подставим при следующем входе.
        if (school) lsSet("sgo.school", school);
        // Кэш мог остаться от предыдущей сессии — после входа грузим заново.
        await clearCache();
        await clearCalcState();
        hydratePromise = null;
        appRevealed = false;
        startApp({ useCache: false });
      } else {
        let msg = userError(res.error || "Ошибка входа");
        msg += "\nПроверьте раскладку RU/EN и лишние пробелы.";
        // Детали входа (логин, длина пароля) — только в служебном режиме.
        if (isDeveloperMode() && res.login) {
          msg += `\nЛогин: «${res.login}», символов в пароле: ${res.passLen}.`;
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
  applyUiSettings();

  // PyWebView может быть ещё не готов — ждём событие pywebviewready.
  if (window.pywebview?.api) {
    reconcileFromNative();
  } else {
    window.addEventListener("pywebviewready", reconcileFromNative, { once: true });
    setTimeout(reconcileFromNative, 1500); // страховка на старые версии
  }

  initSettings();
  document.querySelector("#theme-toggle").addEventListener("click", toggleTheme);

  const markReadButton = document.querySelector("#mark-read");
  if (markReadButton) markReadButton.addEventListener("click", markEverythingRead);

  // Кнопка «Отметить прочитанным» прямо на вкладке «Новое».
  const newReadButton = document.querySelector("#new-read-all");
  if (newReadButton) newReadButton.addEventListener("click", markEverythingRead);

  initNewTab();

  document.querySelector("#tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab && tab.style.display !== "none") selectTab(tab.dataset.tab);
  });

  document.querySelector("#refresh").addEventListener("click", refreshAll);
  const todayRefresh = document.querySelector("#today-refresh");
  if (todayRefresh) todayRefresh.addEventListener("click", refreshAll);
  document.querySelector("#copy").addEventListener("click", copyHomework);
  bindTermSelectors();
  bindResultsControls();

  // «Отметить всё прочитанным» очищает бейджи и подсветку во всех разделах.
  window.addEventListener("sgo:changes-read", () => {
    if (state.grades) renderGradesData(state.grades);
    if (state.diary) renderDiary(state.diary);
    if (state.schedule) renderScheduleData(state.schedule);
  });

  window.addEventListener("sgo:navigate", (event) => {
    const tab = event.detail && event.detail.tab;
    if (tab) selectTab(tab);
  });

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
    // Следующую неделю читаем по-настоящему, а не отдаём предзагрузку.
    loadDiary(d.toISOString().slice(0, 10), { force: true });
  });

  // Переход к дате: открываем нужную неделю и подсвечиваем этот день.
  const diaryDate = document.querySelector("#diary-date");
  if (diaryDate) {
    diaryDate.addEventListener("change", () => {
      const value = diaryDate.value;
      if (!value) return;
      const week = weekStartIso(value);
      if (!week) return;

      const current = state.currentWeek ? weekStartIso(state.currentWeek) : "";
      if (current === week) {
        if (!highlightDiaryDate(value)) toast("На эту дату уроков нет");
        return;
      }
      loadDiary(week).then(() => {
        if (!highlightDiaryDate(value)) toast("На эту дату уроков нет");
      });
    });
  }

  document.querySelectorAll(".btn-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".btn-toggle").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.isShortDay = btn.dataset.mode === "30";
      if (state.schedule) {
        renderScheduleData(state.schedule);
      }
      if (state.tab === "today") renderToday();
    });
  });

  window.addEventListener("sgo:unauthorized", showLogin);

  // Сначала проверяем авторизацию (быстрый локальный запрос), затем сразу
  // показываем кэш — без экрана загрузки и без мигания чужими данными.
  checkAuth().then(async (isAuth) => {
    if (!isAuth) {
      state.authenticated = false;
      showLogin();
      return;
    }
    state.authenticated = true;
    if (await hydrateOnce()) {
      revealCachedApp();
    } else {
      startApp({ useCache: false });
    }
  });

  setInterval(() => {
    if (state.schedule) updateScheduleStatus();
    if (state.tab === "today") updateTodayLive();
  }, 10000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}