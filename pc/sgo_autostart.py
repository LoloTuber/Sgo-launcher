# -*- coding: utf-8 -*-
"""Автозапуск приложения вместе с Windows.

Используется ветка реестра «Run» текущего пользователя:
HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
Запись не требует прав администратора.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Optional

log = logging.getLogger("sgo.autostart")

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE_NAME = "SgoDiary"


def _command() -> str:
    """Команда запуска приложения."""
    if getattr(sys, "frozen", False):
        # Собранный .exe — запускаем как есть.
        return f'"{sys.executable}"'
    # Запуск из исходников: pythonw, чтобы не было окна консоли.
    exe = sys.executable or "pythonw.exe"
    if os.path.basename(exe).lower() in ("python.exe", "python3.exe"):
        candidate = os.path.join(os.path.dirname(exe), "pythonw.exe")
        if os.path.exists(candidate):
            exe = candidate
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "launcher.py")
    return f'"{exe}" "{script}"'


def is_enabled() -> bool:
    """Включён ли автозапуск."""
    if os.name != "nt":
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_READ) as key:
            value, _ = winreg.QueryValueEx(key, VALUE_NAME)
            return bool(str(value).strip())
    except (FileNotFoundError, OSError):
        return False
    except Exception:
        return False


def enable() -> bool:
    """Включает автозапуск. True — получилось."""
    if os.name != "nt":
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, _command())
        log.info("Автозапуск включён")
        return True
    except Exception as exc:
        log.warning("Не удалось включить автозапуск: %s", exc)
        return False


def disable() -> bool:
    """Выключает автозапуск."""
    if os.name != "nt":
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
            try:
                winreg.DeleteValue(key, VALUE_NAME)
            except FileNotFoundError:
                pass
        log.info("Автозапуск выключен")
        return True
    except Exception as exc:
        log.warning("Не удалось выключить автозапуск: %s", exc)
        return False


def set_enabled(enabled: bool) -> bool:
    """Включает или выключает автозапуск."""
    return enable() if enabled else disable()
