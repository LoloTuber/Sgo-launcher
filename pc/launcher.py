# -*- coding: utf-8 -*-
"""Точка входа ПК-версии: локальный HTTP-сервер + окно PyWebView + трей.

Приложение умеет оставаться в фоне:
  * закрытие окна сворачивает его в системный трей, а не закрывает программу;
  * фоновый наблюдатель проверяет дневник и присылает уведомления о новых
    оценках и домашних заданиях;
  * из трея включается автозапуск вместе с Windows.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
import traceback
import urllib.request

import sgo_autostart
import sgo_homework as core
import sgo_settings
import sgo_tray
import sgo_watcher
import sgo_web

HOST = "127.0.0.1"
PORT_CANDIDATES = (8080, 8081, 8082, 8083, 8084, 8085)
TITLE = "Дневник — Сетевой город"
DEBUG = os.getenv("SGO_DEBUG", "").strip() not in ("", "0", "false", "False")

HERE = os.path.dirname(os.path.abspath(__file__))

log = logging.getLogger("sgo")


def show_error(text: str, title: str = TITLE) -> None:
    """Окно с ошибкой: в --windowed сборке консоли нет, иначе ошибку не увидеть."""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x10)
    except Exception:
        pass


def setup_logging() -> None:
    stream = None
    try:
        log_dir = core.config_dir()
        log_dir.mkdir(parents=True, exist_ok=True)
        stream = open(log_dir / "sgo.log", "a", encoding="utf-8", buffering=1)
    except OSError:
        pass

    if stream is not None:
        if sys.stdout is None:
            sys.stdout = stream
        if sys.stderr is None:
            sys.stderr = stream
        logging.basicConfig(
            stream=stream,
            level=logging.DEBUG if DEBUG else logging.INFO,
            format="%(asctime)s %(levelname)s %(message)s",
        )
    else:
        logging.basicConfig(level=logging.INFO)

    sys.excepthook = lambda *exc: log.error(
        "Необработанная ошибка:\n%s", "".join(traceback.format_exception(*exc))
    )


# --- Настройки интерфейса (тема, палитра, фоновый режим) ---
# Хранятся отдельным файлом от sgo_config.json, чтобы не стираться при logout.
class SettingsApi:
    """JS-мост для надёжного сохранения настроек."""

    def get_setting(self, key: str):
        return sgo_settings.load_settings().get(str(key))

    def set_setting(self, key: str, value) -> bool:
        sgo_settings.set_value(key, value)
        return True

    def set_autostart(self, enabled) -> bool:
        """Включает/выключает автозапуск вместе с Windows."""
        ok = sgo_autostart.set_enabled(bool(enabled))
        sgo_settings.set_value(sgo_settings.KEY_AUTOSTART, "1" if ok and enabled else "0")
        if ok:
            sgo_settings.set_value(sgo_settings.KEY_AUTOSTART_NOTE, "")
        return ok


class AppController:
    """Связывает окно, трей и фонового наблюдателя."""

    def __init__(self, state: "sgo_web.AppState", window) -> None:
        self.state = state
        self.window = window
        self.tray: "sgo_tray.TrayIcon | None" = None
        self.watcher: "sgo_watcher.Watcher | None" = None
        self.quitting = False

    # --- Запуск ---
    def start(self) -> None:
        self.watcher = sgo_watcher.Watcher(
            self.state,
            notifier=self.notify,
            on_update=self.on_data_updated,
        )
        self.watcher.start()

        icon_path = sgo_web.resource_path(os.path.join("web", "icon.ico"))
        self.tray = sgo_tray.TrayIcon(
            icon_path,
            tip="Дневник — Сетевой город",
            on_open=self.show_window,
            on_refresh=self.refresh_now,
            on_quit=self.quit,
            on_toggle_background=self.toggle_background,
            on_toggle_notifications=self.toggle_notifications,
            on_toggle_autostart=self.toggle_autostart,
        )
        if self.tray.start():
            self.tray.background_on = sgo_settings.background_enabled()
            self.tray.notifications_on = (
                sgo_settings.notify_marks_enabled() or sgo_settings.notify_homework_enabled()
            )
        else:
            log.warning("Значок в трее недоступен — фоновая проверка будет без уведомлений")
            self.tray = None

        self.check_autostart()

    def check_autostart(self) -> None:
        """Приводит автозапуск в соответствие с реальным состоянием.

        Запись в реестре одна на имя «SgoDiary», поэтому запускаться может
        только одна копия приложения. Если запись указывает на удалённый файл
        (старую версию удалили или перенесли), перенастраиваем её на текущую
        копию. Если автозапуск настроен на другую установленную версию —
        не трогаем её, но предупреждаем пользователя в настройках.
        """
        if os.name != "nt":
            return
        try:
            state = sgo_autostart.status()
            wanted = sgo_settings.get_bool(sgo_settings.KEY_AUTOSTART, False)
            if state["stale"] and wanted:
                if sgo_autostart.repair():
                    log.info("Автозапуск перенастроен на текущую версию")
                    state = sgo_autostart.status()

            # В настройках показываем правду, а не только флажок.
            sgo_settings.set_value(
                sgo_settings.KEY_AUTOSTART, "1" if state["enabled"] else "0"
            )

            note = ""
            if state["stale"]:
                note = (
                    "В настройках Windows автозапуск указывает на удалённый файл. "
                    "Включите его ещё раз — запустится эта версия."
                )
            elif state["other"]:
                note = (
                    "Сейчас автозапуск настроен на другую копию приложения "
                    f"({state['path']}). Включите его, чтобы запускалась эта версия."
                )
            sgo_settings.set_value(sgo_settings.KEY_AUTOSTART_NOTE, note)

            if self.tray:
                self.tray.autostart_on = bool(state["enabled"])
        except Exception:
            log.exception("Не удалось проверить состояние автозапуска")

    def stop(self) -> None:
        if self.watcher:
            self.watcher.stop()
        if self.tray:
            self.tray.stop()

    # --- Действия трея ---
    def notify(self, title: str, message: str) -> None:
        if self.tray:
            self.tray.notify(title, message)
        else:
            log.info("Уведомление: %s — %s", title, message)

    def show_window(self) -> None:
        try:
            self.window.show()
            self.window.restore()
        except Exception:
            log.exception("Не удалось показать окно")
            return
        self.sync_web_settings()
        self.refresh_now()

    def refresh_now(self) -> None:
        if self.watcher:
            self.watcher.wake()
        self.run_js("document.querySelector('#refresh')?.click();")

    def toggle_background(self, enabled: bool) -> None:
        sgo_settings.set_value(sgo_settings.KEY_BACKGROUND, "1" if enabled else "0")
        log.info("Фоновые обновления: %s", "вкл" if enabled else "выкл")
        self.sync_web_settings()

    def toggle_notifications(self, enabled: bool) -> None:
        sgo_settings.set_value(sgo_settings.KEY_NOTIFY_MARKS, "1" if enabled else "0")
        sgo_settings.set_value(sgo_settings.KEY_NOTIFY_HOMEWORK, "1" if enabled else "0")
        log.info("Уведомления: %s", "вкл" if enabled else "выкл")
        self.sync_web_settings()

    def toggle_autostart(self, enabled: bool) -> None:
        ok = sgo_autostart.set_enabled(enabled)
        if self.tray:
            self.tray.autostart_on = ok and enabled
        sgo_settings.set_value(
            sgo_settings.KEY_AUTOSTART, "1" if ok and enabled else "0"
        )
        if ok:
            sgo_settings.set_value(sgo_settings.KEY_AUTOSTART_NOTE, "")
        log.info("Автозапуск: %s", "вкл" if enabled else "выкл")
        # Окно должно показать новое состояние чекбокса.
        self.sync_web_settings()

    def quit(self) -> None:
        self.quitting = True
        try:
            self.window.destroy()
        except Exception:
            log.exception("Не удалось закрыть окно")

    # --- Прочее ---
    def on_data_updated(self) -> None:
        """Фоновая проверка нашла изменения — обновляем открытое окно."""
        self.run_js("window.dispatchEvent(new Event('sgo:data-updated'));")

    def sync_web_settings(self) -> None:
        self.run_js("window.dispatchEvent(new Event('sgo:sync-settings'));")

    def run_js(self, script: str) -> None:
        try:
            self.window.evaluate_js(script)
        except Exception:
            # Окно ещё не загрузилось или уже закрыто — не критично.
            pass

    def on_closing(self) -> bool:
        """Закрытие окна: сворачиваем в трей вместо выхода из программы."""
        if self.quitting or self.tray is None:
            return True
        log.info("Окно скрыто, приложение продолжает работать в фоне")
        threading.Timer(0.15, self.hide_window).start()
        return False

    def hide_window(self) -> None:
        try:
            self.window.hide()
        except Exception:
            log.exception("Не удалось скрыть окно")


def start_server(state: "sgo_web.AppState") -> tuple:
    last_error = None
    for port in PORT_CANDIDATES:
        try:
            server = sgo_web.create_server(HOST, port, state)
            return server, port
        except OSError as exc:
            last_error = exc
            log.warning("Порт %s занят: %s", port, exc)
    raise RuntimeError(f"Не удалось занять ни один порт {PORT_CANDIDATES}: {last_error}")


def wait_for_server(port: int, timeout: float = 20.0) -> bool:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    url = f"http://{HOST}:{port}/api/ping"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with opener.open(url, timeout=1) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(0.1)
    return False


def warm_up(state: "sgo_web.AppState") -> None:
    config = state.config
    if not (config.get("login") and config.get("password")):
        return
    try:
        with state.lock:
            state.connect()
        log.info("Автовход выполнен: %s", state.client.student_name if state.client else "")
    except Exception as exc:
        log.warning("Автовход не удался: %s", exc)


def main() -> int:
    setup_logging()
    log.info("Запуск приложения")

    state = sgo_web.AppState(core.load_config())
    try:
        server, port = start_server(state)
    except Exception as exc:
        log.exception("Не удалось запустить сервер")
        show_error(f"Не удалось запустить локальный сервер.\n\n{exc}")
        return 1

    threading.Thread(target=server.serve_forever, name="sgo-http", daemon=True).start()

    if not wait_for_server(port):
        log.error("Сервер не ответил на /api/ping")
        server.shutdown()
        show_error("Локальный сервер не запустился за 20 секунд.\nПодробности: %APPDATA%\\SgoDiary\\sgo.log")
        return 1
    log.info("Сервер готов: http://%s:%s/", HOST, port)

    threading.Thread(target=warm_up, args=(state,), name="sgo-auth", daemon=True).start()

    try:
        import webview
    except Exception as exc:
        log.exception("PyWebView не загрузился")
        show_error(
            "Не удалось загрузить PyWebView.\n"
            "Установите компонент «WebView2 Runtime» от Microsoft.\n\n"
            f"{exc}"
        )
        server.shutdown()
        return 1

    window = webview.create_window(
        title=TITLE,
        url=f"http://{HOST}:{port}/",
        width=1100,
        height=800,
        min_size=(900, 600),
        js_api=SettingsApi(),
    )

    controller = AppController(state, window)
    controller.start()
    window.events.closing += controller.on_closing

    try:
        # КЛЮЧЕВОЙ ФИКС: private_mode=False, иначе localStorage стирается при закрытии.
        # В PyWebView >= 4.0 приватный режим включён по умолчанию (True).
        webview.start(debug=DEBUG, private_mode=False)
    except Exception as exc:
        log.exception("Окно PyWebView упало")
        show_error(f"Ошибка окна приложения:\n{exc}")
        return 1
    finally:
        log.info("Завершение работы")
        controller.stop()
        server.shutdown()
        server.server_close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
