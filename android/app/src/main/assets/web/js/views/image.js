/**
 * Модуль «Изображение» на главном экране.
 *
 * Пользователь выбирает картинку со своего устройства — она сохраняется
 * на сервере приложения (в папке с данными) и показывается на главном
 * экране. Файл можно заменить или удалить.
 *
 * Перед отправкой картинка уменьшается (до 1600 px по большей стороне),
 * чтобы не гонять по сети и не забивать память телефона.
 */

import { escapeHtml } from "../utils.js";

const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.85;

let info = null; // { has, mime, updated }
let message = { text: "", isError: false }; // последнее сообщение модуля

/** Актуальные сведения о сохранённой картинке (null — неизвестно). */
export function getImageInfo() {
  return info;
}

/**
 * Загружает сведения о картинке, если их ещё нет.
 * Вызывается при первом рендере главного экрана.
 */
export function ensureImageInfo() {
  if (info) return Promise.resolve(info);
  return loadImageInfo();
}

/** Запрашивает у сервера сведения о картинке. */
export async function loadImageInfo() {
  try {
    const res = await fetch("/api/home-image/info", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    info = { has: !!data.has, mime: data.mime || "", updated: data.updated || "" };
  } catch (_) {
    info = { has: false, mime: "", updated: "" };
  }
  return info;
}

/** Разметка модуля. */
export function renderImageModule() {
  const has = !!(info && info.has);
  const body = has
    ? `<img class="home-image-img" src="/api/home-image?v=${encodeURIComponent((info && info.updated) || "1")}" alt="Своё изображение" />`
    : `<div class="home-image-empty">
         <span class="home-image-empty-icon" aria-hidden="true">🖼</span>
         <span>Здесь можно поставить своё фото</span>
       </div>`;

  return `
    <article class="today-card home-module-card home-image-card">
      <div class="today-card-head">
        <h3>Изображение</h3>
        <div class="today-card-actions">
          <button class="btn btn-outline home-image-pick" type="button">${has ? "Заменить" : "Выбрать фото"}</button>
          ${has ? `<button class="btn btn-outline home-image-remove" type="button">Удалить</button>` : ""}
        </div>
      </div>
      <div class="home-image-body">${body}</div>
      <input type="file" id="home-image-input" accept="image/*" class="home-image-input"
             aria-label="Выбрать изображение для главного экрана" />
      <p class="home-image-hint subtle ${message.isError ? "is-error" : ""}">${escapeHtml(message.text || "")}</p>
    </article>
  `;
}

/** Подписывает обработчики модуля (выбор файла, замена, удаление). */
export function bindImageModule(container, onChanged) {
  const card = container.querySelector(".home-image-card");
  if (!card) return;

  const input = card.querySelector("#home-image-input");
  const pick = card.querySelector(".home-image-pick");
  const remove = card.querySelector(".home-image-remove");
  const hint = card.querySelector(".home-image-hint");

  const setHint = (text, isError) => {
    message = { text: text || "", isError: !!isError };
    if (!hint) return;
    hint.textContent = message.text;
    hint.classList.toggle("is-error", message.isError);
  };

  if (pick && input) {
    pick.addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      setHint("Сохраняем изображение…", false);
      try {
        const dataUrl = await shrinkImage(file);
        const res = await fetch("/api/home-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: dataUrl }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        await loadImageInfo();
        setHint("Изображение сохранено", false);
        if (onChanged) onChanged();
      } catch (err) {
        setHint("Не удалось сохранить изображение: " + (err && err.message ? err.message : "ошибка"), true);
      } finally {
        input.value = "";
      }
    });
  }

  if (remove) {
    remove.addEventListener("click", async () => {
      setHint("Удаляем…", false);
      try {
        const res = await fetch("/api/home-image", { method: "DELETE" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        await loadImageInfo();
        setHint("Изображение удалено", false);
        if (onChanged) onChanged();
      } catch (err) {
        setHint("Не удалось удалить: " + (err && err.message ? err.message : "ошибка"), true);
      }
    });
  }
}

/**
 * Уменьшает картинку и превращает её в data URL.
 * Если браузер не умеет работать с canvas — отдаём исходный файл.
 */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("не удалось прочитать файл"));
    reader.onload = () => {
      const source = String(reader.result || "");
      const img = new Image();
      img.onerror = () => resolve(source);
      img.onload = () => {
        try {
          const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
          const width = Math.max(1, Math.round(img.width * scale));
          const height = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) { resolve(source); return; }
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
        } catch (_) {
          resolve(source);
        }
      };
      img.src = source;
    };
    reader.readAsDataURL(file);
  });
}
