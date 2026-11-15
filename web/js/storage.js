/**
 * Надёжное хранилище: localStorage + мосты PyWebView/Android.
 *
 * localStorage может быть недоступен (private_mode, file://, смена порта),
 * поэтому дублируем запись в нативные настройки. Все обращения обёрнуты
 * в try/catch: хранилище вспомогательное, его сбой не должен ломать UI.
 */

/** Читает значение по ключу. null — если ключа нет или хранилище недоступно. */
export async function storageGet(key) {
  try {
    const value = localStorage.getItem(key);
    if (value !== null) return value;
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

/** Сохраняет значение по ключу. Ошибки молча игнорируются. */
export async function storageSet(key, value) {
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

/**
 * Читает значение только из нативного хранилища (без localStorage).
 *
 * Нужно, чтобы сверять настройки с тем, что записала нативная часть
 * (например, переключатель в трее на Windows или фоновый сервис на Android).
 */
export async function storageGetNative(key) {
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

/** Удаляет значение по ключу из localStorage и нативного хранилища. */
export async function storageRemove(key) {
  try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
  try {
    if (window.pywebview?.api?.set_setting) {
      await window.pywebview.api.set_setting(key, "");
    }
  } catch (_) { /* ignore */ }
  try {
    if (window.AndroidSettings?.remove) {
      window.AndroidSettings.remove(key);
    }
  } catch (_) { /* ignore */ }
}
