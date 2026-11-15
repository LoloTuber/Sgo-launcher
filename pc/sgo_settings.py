# -*- coding: utf-8 -*-
"""Настройки интерфейса и фонового режима — общий доступ из JS и Python.

Веб-интерфейс пишет настройки через мост (PyWebView/Android), а Python
читает тот же файл — так фоновый наблюдатель узнаёт про интервал проверки
и включённые уведомления, не требуя перезапуска приложения.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

import sgo_homework as core

SETTINGS_NAME = "sgo_settings.json"

# Ключи совпадают с теми, что использует веб-интерфейс (js/settings.js).
KEY_BACKGROUND = "sgo.backgroundEnabled"
KEY_NOTIFY_MARKS = "sgo.notifyMarks"
KEY_NOTIFY_HOMEWORK = "sgo.notifyHomework"
KEY_INTERVAL = "sgo.backgroundInterval"
KEY_AUTOSTART = "sgo.autostart"
# Пояснение для настроек: автозапуск указывает на удалённый файл или на другую копию.
KEY_AUTOSTART_NOTE = "sgo.autostartNote"

DEFAULT_INTERVAL_MIN = 10
MIN_INTERVAL_MIN = 1
MAX_INTERVAL_MIN = 240


def settings_path() -> Path:
    return core.config_dir() / SETTINGS_NAME


def load_settings() -> Dict[str, Any]:
    """Читает настройки. Недоступный файл — пустые настройки."""
    try:
        data = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_settings(data: Dict[str, Any]) -> None:
    path = settings_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def set_value(key: str, value: Any) -> None:
    data = load_settings()
    data[str(key)] = value
    save_settings(data)


def get_value(key: str, default: Any = None) -> Any:
    return load_settings().get(str(key), default)


def get_bool(key: str, default: bool = True) -> bool:
    value = load_settings().get(str(key))
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def get_int(key: str, default: int = DEFAULT_INTERVAL_MIN) -> int:
    value = load_settings().get(str(key))
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return max(MIN_INTERVAL_MIN, min(MAX_INTERVAL_MIN, number))


def interval_minutes() -> int:
    """Интервал фоновой проверки в минутах."""
    return get_int(KEY_INTERVAL, DEFAULT_INTERVAL_MIN)


def background_enabled() -> bool:
    return get_bool(KEY_BACKGROUND, True)


def notifications_enabled() -> bool:
    """Есть ли смысл вообще что-то показывать."""
    return background_enabled() and (
        notify_marks_enabled() or notify_homework_enabled()
    )


def notify_marks_enabled() -> bool:
    return get_bool(KEY_NOTIFY_MARKS, True)


def notify_homework_enabled() -> bool:
    return get_bool(KEY_NOTIFY_HOMEWORK, True)
