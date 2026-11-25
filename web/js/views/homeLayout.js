/**
 * Настройка раскладки главного экрана (вкладка «Главная» в настройках).
 *
 * Модуль можно скрыть/показать, переставить перетаскиванием и задать ему
 * ширину — от одной до трёх колонок. Порядок, видимость и ширина хранятся
 * в js/modules.js.
 */

import {
  HOME_MODULES, getHomeLayout, setModuleVisible, setModuleOrder, moveModule,
  setModuleSpan, getModuleSpan, setGridColumns, getGridColumns, moduleTitle,
  getModuleHeight, setModuleHeight, clearModuleHeights,
  saveHomeLayout,
} from "../modules.js";
import { escapeHtml } from "../utils.js";

let dragId = null;

/**
 * Рисует список модулей: чекбокс «показывать», название, ручка
 * для перетаскивания, кнопки «вверх/вниз» (на касании перетаскивание
 * не работает — там нужны обычные кнопки) и выбор ширины в колонках.
 */
export function renderModuleList(container, onChanged) {
  if (!container) return;
  const layout = getHomeLayout();
  const columns = getGridColumns(layout);

  const items = layout.order.map((id, index) => {
    const meta = HOME_MODULES.find((item) => item.id === id);
    const visible = !layout.hidden.includes(id);
    const title = meta ? meta.title : moduleTitle(id);
    const hint = meta ? meta.hint : "";
    const span = Math.min(getModuleSpan(id, layout), columns);

    // Ширина одной колонки, когда колонка одна, смысла не имеет.
    const widthSelect = columns > 1
      ? `<select class="module-width" data-module-id="${escapeHtml(id)}" aria-label="Ширина модуля">
           ${Array.from({ length: columns }, (_, i) => i + 1).map((value) => `
             <option value="${value}" ${value === span ? "selected" : ""}>${value}</option>`).join("")}
         </select>`
      : "";

    // Заданная высота модуля и кнопка возврата к обычной.
    const height = getModuleHeight(id, layout);
    const heightBox = height
      ? `<span class="module-row-height">
           <span class="module-height-value">${height} px</span>
           <button class="module-height-reset" type="button" data-reset-height="${escapeHtml(id)}"
                   title="Вернуть высоту по содержимому" aria-label="Вернуть высоту по содержимому">⟲</button>
         </span>`
      : "";

    return `
      <div class="module-row ${visible ? "" : "is-hidden"}" draggable="true" data-module-id="${escapeHtml(id)}">
        <span class="module-drag" title="Перетащите, чтобы изменить порядок">⋮⋮</span>
        <label class="module-row-label">
          <input type="checkbox" class="module-visible" data-module-id="${escapeHtml(id)}" ${visible ? "checked" : ""}>
          <span class="module-row-title">${escapeHtml(title)}</span>
          <span class="module-row-hint">${escapeHtml(hint)}</span>
        </label>
        <span class="module-row-width">${widthSelect}</span>
        <span class="module-row-height-cell">${heightBox}</span>
        <span class="module-row-move">
          <button class="module-move-btn" type="button" data-move="-1" data-module-id="${escapeHtml(id)}"
                  title="Поднять выше" aria-label="Поднять выше" ${index === 0 ? "disabled" : ""}>↑</button>
          <button class="module-move-btn" type="button" data-move="1" data-module-id="${escapeHtml(id)}"
                  title="Опустить ниже" aria-label="Опустить ниже" ${index === layout.order.length - 1 ? "disabled" : ""}>↓</button>
        </span>
      </div>
    `;
  });

  container.innerHTML = items.join("");

  // Показ/скрытие модуля.
  container.querySelectorAll(".module-visible").forEach((box) => {
    box.addEventListener("change", () => {
      setModuleVisible(box.dataset.moduleId, box.checked);
      renderModuleList(container, onChanged);
      if (onChanged) onChanged();
    });
  });

  // Ширина модуля в колонках.
  container.querySelectorAll(".module-width").forEach((select) => {
    select.addEventListener("change", () => {
      setModuleSpan(select.dataset.moduleId, Number(select.value));
      renderModuleList(container, onChanged);
      if (onChanged) onChanged();
    });
  });

  // Возврат высоты модуля к обычной.
  container.querySelectorAll(".module-height-reset").forEach((btn) => {
    btn.addEventListener("click", () => {
      setModuleHeight(btn.dataset.resetHeight, 0);
      renderModuleList(container, onChanged);
      if (onChanged) onChanged();
    });
  });

  // Перемещение кнопками — работает и на касании.
  container.querySelectorAll(".module-move-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const delta = Number(btn.dataset.move) < 0 ? -1 : 1;
      moveModule(btn.dataset.moduleId, delta);
      renderModuleList(container, onChanged);
      if (onChanged) onChanged();
    });
  });

  // Перетаскивание для смены порядка.
  container.querySelectorAll(".module-row").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      dragId = row.dataset.moduleId;
      row.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        try { event.dataTransfer.setData("text/plain", dragId); } catch (_) { /* ignore */ }
      }
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("is-dragging");
      dragId = null;
    });
    row.addEventListener("dragover", (event) => {
      if (!dragId || dragId === row.dataset.moduleId) return;
      event.preventDefault();
      row.classList.add("is-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("is-over"));
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      row.classList.remove("is-over");
      const source = dragId || (event.dataTransfer ? event.dataTransfer.getData("text/plain") : "");
      const target = row.dataset.moduleId;
      if (!source || !target || source === target) return;
      const layoutNow = getHomeLayout();
      const order = layoutNow.order.slice();
      const from = order.indexOf(source);
      const to = order.indexOf(target);
      if (from < 0 || to < 0) return;
      order.splice(from, 1);
      order.splice(to, 0, source);
      setModuleOrder(order);
      renderModuleList(container, onChanged);
      if (onChanged) onChanged();
    });
  });
}

/**
 * Число колонок сетки главного экрана (1–3).
 */
export function bindGridColumns(select, onChanged) {
  if (!select) return;
  select.value = String(getGridColumns());
  select.addEventListener("change", () => {
    setGridColumns(Number(select.value));
    if (onChanged) onChanged();
  });
}

/** Возвращает порядок модулей к умолчанию. */
export function resetModuleLayout(container, onChanged) {
  const layout = getHomeLayout();
  const defaults = HOME_MODULES.map((item) => item.id);
  layout.order = defaults;
  layout.hidden = [];
  layout.spans = {};
  layout.columns = 1;
  layout.wide = [];
  layout.heights = {};
  setModuleOrder(defaults);
  clearModuleHeights();
  saveHomeLayout(layout);
  renderModuleList(container, onChanged);
  if (onChanged) onChanged();
}
