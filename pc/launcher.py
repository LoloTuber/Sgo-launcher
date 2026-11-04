# -*- coding: utf-8 -*-
"""Точка входа ПК-версии: локальный HTTP-сервер + окно PyWebView."""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import traceback
import urllib.request

import sgo_homework as core
import sgo_web

HOST = "127.0.0.1"
PORT_CANDIDATES = (8080, 8081, 8082, 8083, 8084, 8085)
TITLE = "Дневник — Сетевой город"
DEBUG = os.getenv("SGO_DEBUG", "").strip() not in ("", "0", "false", "False")

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


# --- Настройки интерфейса (тема, палитра) через отдельный файл ---
# Хранится отдельно от sgo_config.json, чтобы не стираться при logout.
class SettingsApi:
    """JS-мост для надёжного сохранения настроек интерфейса."""

    def __init__(self) -> None:
        self._path = core.config_dir() / "sgo_settings.json"

    def _load(self) -> dict:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self, data: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_name(self._path.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self._path)

    def get_setting(self, key: str):
        return self._load().get(str(key))

    def set_setting(self, key: str, value) -> bool:
        data = self._load()
        data[str(key)] = value
        self._save(data)
        return True


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

    webview.create_window(
        title=TITLE,
        url=f"http://{HOST}:{port}/",
        width=1100,
        height=800,
        min_size=(900, 600),
        js_api=SettingsApi(),
    )

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
        server.shutdown()
        server.server_close()

    return 0


if __name__ == "__main__":
    sys.exit(main())