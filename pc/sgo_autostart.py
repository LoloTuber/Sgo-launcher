# -*- coding: utf-8 -*-
"""Автозапуск приложения вместе с Windows.

Используется ветка реестра «Run» текущего пользователя:
HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
Запись не требует прав администратора.

Запись в реестре одна на имя «SgoDiary», поэтому одновременно автозапуск
работает только у одной копии приложения. Чтобы это не приводило к
непонятным ситуациям, состояние считаем честно:

- registered — запись в реестре есть;
- target_exists — файл, на который указывает запись, на месте;
- points_to_current — запись указывает именно на эту копию;
- enabled — запись есть, файл на месте и это текущая копия;
- stale — запись есть, но файла уже нет (например, старую версию удалили);
- other — запись указывает на другую установленную копию приложения.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Dict, List, Optional

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


def _read_command() -> str:
    """Текущая запись автозапуска (пустая строка — если её нет)."""
    if os.name != "nt":
        return ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_READ) as key:
            value, _ = winreg.QueryValueEx(key, VALUE_NAME)
            return str(value).strip()
    except (FileNotFoundError, OSError):
        return ""
    except Exception:
        return ""


def _paths(command: str) -> List[str]:
    """Пути из команды автозапуска."""
    out: List[str] = []
    text = (command or "").strip()
    if not text:
        return out
    rest = text
    while True:
        start = rest.find('"')
        if start == -1:
            break
        end = rest.find('"', start + 1)
        if end == -1:
            break
        out.append(rest[start + 1:end])
        rest = rest[end + 1:]
    if not out:
        # Без кавычек: путь до .exe.
        low = text.lower()
        idx = low.find(".exe")
        if idx != -1:
            out.append(text[: idx + 4])
    return out


def _norm(path: str) -> str:
    try:
        return os.path.normcase(os.path.abspath(path))
    except Exception:
        return str(path).lower()


def _current_path() -> str:
    """Путь, который должен стоять в автозапуске у текущей копии."""
    if getattr(sys, "frozen", False):
        return _norm(sys.executable)
    return _norm(os.path.join(os.path.dirname(os.path.abspath(__file__)), "launcher.py"))


def status() -> Dict[str, object]:
    """Реальное состояние автозапуска."""
    command = _read_command()
    paths = _paths(command)
    registered = bool(command)
    target_exists = bool(paths) and all(os.path.exists(p) for p in paths)
    current = _current_path()
    points_to_current = any(_norm(p) == current for p in paths)
    return {
        "registered": registered,
        "command": command,
        "path": paths[-1] if paths else "",
        "target_exists": target_exists,
        "points_to_current": points_to_current,
        "enabled": bool(registered and target_exists and points_to_current),
        # Запись есть, а файла уже нет — при входе в Windows будет ошибка.
        "stale": bool(registered and not target_exists),
        # Запись указывает на другую копию, которая ещё на месте.
        "other": bool(registered and target_exists and not points_to_current),
    }


def is_enabled() -> bool:
    """Включён ли автозапуск именно для этой копии."""
    return bool(status()["enabled"])


def is_stale() -> bool:
    """Запись автозапуска указывает на несуществующий файл."""
    return bool(status()["stale"])


def enable() -> bool:
    """Включает автозапуск (запись перезаписывается на текущую копию)."""
    if os.name != "nt":
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, _command())
        log.info("Автозапуск включён: %s", _command())
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


def repair() -> bool:
    """Чинит запись, которая указывает на удалённый файл.

    Вызывается при запуске приложения: пользователь просил автозапуск,
    значит перенастроить его на текущую копию — в его интересах.
    """
    st = status()
    if not st["stale"]:
        return False
    log.info("Автозапуск указывает на несуществующий файл %s — перенастраиваю", st["path"])
    return enable()
