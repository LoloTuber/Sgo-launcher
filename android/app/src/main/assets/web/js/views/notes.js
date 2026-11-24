/**
 * Модуль «Заметки» на главном экране.
 *
 * Заметка одна и занимает весь экран модуля: обычный текст, который
 * правится прямо на месте. Сохраняется автоматически (в localStorage и
 * в нативном хранилище приложения), чтобы не потеряться при перезапуске.
 */

import { storageGet, storageSet } from "../storage.js";

const STORAGE_KEY = "sgo.notes";
const SAVE_DELAY = 600;

let cachedText = null;
let saveTimer = null;

function readRaw() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
}

/** Текущий текст заметки. */
export function getNote() {
  if (cachedText != null) return cachedText;
  const raw = readRaw();
  cachedText = raw == null ? "" : raw;
  return cachedText;
}

/** Сохраняет заметку. */
export function saveNote(text) {
  cachedText = String(text == null ? "" : text);
  try { localStorage.setItem(STORAGE_KEY, cachedText); } catch (_) { /* ignore */ }
  storageSet(STORAGE_KEY, cachedText).catch(() => {});
  return cachedText;
}

/** Подтягивает заметку из нативного хранилища (если localStorage пуст). */
export async function restoreNote() {
  if (cachedText) return cachedText;
  const raw = await storageGet(STORAGE_KEY);
  if (raw != null) {
    cachedText = String(raw);
    try { localStorage.setItem(STORAGE_KEY, cachedText); } catch (_) { /* ignore */ }
  }
  return cachedText || "";
}

/**
 * Модуль заметок. Возвращает разметку карточки — вставку делает
 * главный экран (он собирает модули по раскладке).
 */
export function renderNotesModule() {
  const text = getNote();
  return `
    <article class="today-card home-module-card home-notes-card">
      <div class="today-card-head">
        <h3>Заметки</h3>
        <span class="home-notes-status" id="home-notes-status" aria-live="polite"></span>
      </div>
      <textarea id="home-notes-input" class="home-notes-input"
                placeholder="Запишите здесь что угодно — текст сохраняется сам."
                spellcheck="true">${escapeTextarea(text)}</textarea>
    </article>
  `;
}

/** Экранирует текст для вставки внутрь <textarea>. */
function escapeTextarea(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Подписывает автосохранение заметки. Вызывается после вставки модуля
 * в главный экран.
 */
export function bindNotesModule(container) {
  const input = container.querySelector("#home-notes-input");
  const status = container.querySelector("#home-notes-status");
  if (!input) return;

  input.addEventListener("input", () => {
    if (status) status.textContent = "сохраняем…";
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveNote(input.value);
      if (status) status.textContent = "сохранено";
    }, SAVE_DELAY);
  });

  // Уход со страницы не должен терять несохранённый текст.
  input.addEventListener("blur", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      saveNote(input.value);
    }
    if (status) status.textContent = "сохранено";
  });
}
