# -*- coding: utf-8 -*-
"""Значок в системном трее Windows — на чистом ctypes, без внешних пакетов.

Приложение умеет:
  * жить в трее, пока окно скрыто;
  * показывать всплывающие уведомления (новые оценки и домашние задания);
  * открывать окно по клику, обновлять данные по требованию;
  * переключать фоновый режим, уведомления и автозапуск прямо из меню.

Реализация: своё скрытое окно + Shell_NotifyIcon + цикл сообщений
в отдельном потоке. Внешние зависимости не нужны — это важно, потому что
сборка идёт через PyInstaller.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import logging
import os
import threading
from typing import Callable, List, Optional, Tuple

log = logging.getLogger("sgo.tray")

# --- Константы Win32 -------------------------------------------------------
WM_APP = 0x8000
WM_TRAY = WM_APP + 20
WM_DESTROY = 0x0002
WM_COMMAND = 0x0111
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONUP = 0x0205
WM_CONTEXTMENU = 0x007B

NIM_ADD, NIM_MODIFY, NIM_DELETE = 0, 1, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP, NIF_INFO = 0x01, 0x02, 0x04, 0x10
NIIF_INFO = 0x01

IMAGE_ICON = 1
LR_LOADFROMFILE = 0x00000010
LR_DEFAULTSIZE = 0x00000040

MF_STRING = 0x0000
MF_SEPARATOR = 0x0800
MF_CHECKED = 0x0008
MF_GRAYED = 0x0001

TPM_RIGHTBUTTON = 0x0002
TPM_RETURNCMD = 0x0100
TPM_NONOTIFY = 0x0080

IDI_TRAY_ID = 1

CMD_OPEN = 1001
CMD_REFRESH = 1002
CMD_TOGGLE_BACKGROUND = 1003
CMD_TOGGLE_NOTIFICATIONS = 1004
CMD_TOGGLE_AUTOSTART = 1005
CMD_QUIT = 1006

LRESULT = ctypes.c_longlong
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM)


class _WNDCLASS(ctypes.Structure):
    _fields_ = [
        ("style", ctypes.c_uint),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wt.HINSTANCE),
        ("hIcon", wt.HICON),
        ("hCursor", wt.HANDLE),
        ("hbrBackground", wt.HBRUSH),
        ("lpszMenuName", wt.LPCWSTR),
        ("lpszClassName", wt.LPCWSTR),
    ]


class _NOTIFYICONDATA(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_uint),
        ("hWnd", wt.HWND),
        ("uID", ctypes.c_uint),
        ("uFlags", ctypes.c_uint),
        ("uCallbackMessage", ctypes.c_uint),
        ("hIcon", wt.HICON),
        ("szTip", wt.WCHAR * 128),
        ("dwState", ctypes.c_uint),
        ("dwStateMask", ctypes.c_uint),
        ("szInfo", wt.WCHAR * 256),
        ("uTimeoutOrVersion", ctypes.c_uint),
        ("szInfoTitle", wt.WCHAR * 64),
        ("dwInfoFlags", ctypes.c_uint),
        ("guidItem", ctypes.c_byte * 16),
        ("hBalloonIcon", wt.HICON),
    ]


class _MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wt.HWND),
        ("message", ctypes.c_uint),
        ("wParam", wt.WPARAM),
        ("lParam", wt.LPARAM),
        ("time", ctypes.c_uint),
        ("pt", wt.POINT),
    ]


_USER32 = None
_SHELL32 = None
_KERNEL32 = None


def _init_api() -> None:
    """Объявляет сигнатуры Win32-функций (важно для 64-битной Windows)."""
    global _USER32, _SHELL32, _KERNEL32
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    user32.RegisterClassW.argtypes = [ctypes.POINTER(_WNDCLASS)]
    user32.RegisterClassW.restype = ctypes.c_ushort

    user32.CreateWindowExW.argtypes = [
        ctypes.c_ulong, wt.LPCWSTR, wt.LPCWSTR, ctypes.c_ulong,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wt.HWND, wt.HMENU, wt.HINSTANCE, wt.LPVOID,
    ]
    user32.CreateWindowExW.restype = wt.HWND

    user32.DefWindowProcW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
    user32.DefWindowProcW.restype = LRESULT

    user32.DestroyWindow.argtypes = [wt.HWND]
    user32.DestroyWindow.restype = ctypes.c_bool

    user32.PostQuitMessage.argtypes = [ctypes.c_int]
    user32.PostQuitMessage.restype = None

    user32.GetMessageW.argtypes = [ctypes.POINTER(_MSG), wt.HWND, ctypes.c_uint, ctypes.c_uint]
    user32.GetMessageW.restype = ctypes.c_int

    user32.TranslateMessage.argtypes = [ctypes.POINTER(_MSG)]
    user32.TranslateMessage.restype = ctypes.c_bool

    user32.DispatchMessageW.argtypes = [ctypes.POINTER(_MSG)]
    user32.DispatchMessageW.restype = LRESULT

    user32.LoadImageW.argtypes = [
        wt.HINSTANCE, wt.LPCWSTR, ctypes.c_uint,
        ctypes.c_int, ctypes.c_int, ctypes.c_uint,
    ]
    user32.LoadImageW.restype = wt.HANDLE

    user32.DestroyIcon.argtypes = [wt.HICON]
    user32.DestroyIcon.restype = ctypes.c_bool

    user32.CreatePopupMenu.restype = wt.HMENU
    user32.AppendMenuW.argtypes = [wt.HMENU, ctypes.c_uint, ctypes.c_size_t, wt.LPCWSTR]
    user32.AppendMenuW.restype = ctypes.c_bool
    user32.TrackPopupMenu.argtypes = [
        wt.HMENU, ctypes.c_uint, ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.HWND, wt.LPVOID,
    ]
    user32.TrackPopupMenu.restype = ctypes.c_int
    user32.DestroyMenu.argtypes = [wt.HMENU]
    user32.DestroyMenu.restype = ctypes.c_bool

    user32.SetForegroundWindow.argtypes = [wt.HWND]
    user32.SetForegroundWindow.restype = ctypes.c_bool

    user32.RegisterWindowMessageW.argtypes = [wt.LPCWSTR]
    user32.RegisterWindowMessageW.restype = ctypes.c_uint

    user32.PostMessageW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
    user32.PostMessageW.restype = ctypes.c_bool

    user32.GetCursorPos.argtypes = [ctypes.POINTER(wt.POINT)]
    user32.GetCursorPos.restype = ctypes.c_bool

    shell32.Shell_NotifyIconW.argtypes = [ctypes.c_uint, ctypes.POINTER(_NOTIFYICONDATA)]
    shell32.Shell_NotifyIconW.restype = ctypes.c_bool

    kernel32.GetModuleHandleW.argtypes = [wt.LPCWSTR]
    kernel32.GetModuleHandleW.restype = wt.HMODULE

    _USER32, _SHELL32, _KERNEL32 = user32, shell32, kernel32


class TrayIcon:
    """Значок в трее с меню и всплывающими уведомлениями."""

    def __init__(
        self,
        icon_path: str,
        tip: str = "Дневник — Сетевой город",
        on_open: Optional[Callable[[], None]] = None,
        on_refresh: Optional[Callable[[], None]] = None,
        on_quit: Optional[Callable[[], None]] = None,
        on_toggle_background: Optional[Callable[[bool], None]] = None,
        on_toggle_notifications: Optional[Callable[[bool], None]] = None,
        on_toggle_autostart: Optional[Callable[[bool], None]] = None,
    ) -> None:
        self.icon_path = icon_path
        self.tip = tip
        self.on_open = on_open
        self.on_refresh = on_refresh
        self.on_quit = on_quit
        self.on_toggle_background = on_toggle_background
        self.on_toggle_notifications = on_toggle_notifications
        self.on_toggle_autostart = on_toggle_autostart

        # Состояние меню — обновляется из настроек.
        self.background_on = True
        self.notifications_on = True
        self.autostart_on = False
        self.autostart_available = True

        self._thread: Optional[threading.Thread] = None
        self._hwnd = None
        self._icon = None
        self._nid = None
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._taskbar_created = 0

    # --- Публичный API ---
    def start(self) -> bool:
        """Запускает поток трея. False — если значок не удалось создать."""
        if self._thread is not None:
            return True
        if os.name != "nt":
            log.info("Трей доступен только в Windows")
            return False
        self._thread = threading.Thread(target=self._run, name="sgo-tray", daemon=True)
        self._thread.start()
        return self._ready.wait(timeout=5.0)

    def stop(self) -> None:
        self._stop.set()
        if self._hwnd and _USER32 is not None:
            try:
                _USER32.PostMessageW(self._hwnd, WM_DESTROY, 0, 0)
            except Exception:
                pass
        if self._thread is not None:
            self._thread.join(timeout=3.0)

    def notify(self, title: str, message: str) -> None:
        """Показывает всплывающее уведомление."""
        if not self._ready.is_set():
            return
        try:
            self._show_balloon(title, message)
        except Exception as exc:
            log.warning("Не удалось показать уведомление: %s", exc)

    def set_tooltip(self, text: str) -> None:
        if not self._ready.is_set():
            return
        try:
            self._nid.szTip = text[:127]
            self._modify()
        except Exception:
            pass

    def update_menu(self) -> None:
        """Обновляет «галочки» в меню (например, после смены настроек)."""
        if not self._ready.is_set() or _USER32 is None:
            return
        try:
            _USER32.PostMessageW(self._hwnd, WM_COMMAND, CMD_OPEN, 0)
        except Exception:
            pass

    # --- Внутреннее ---
    def _run(self) -> None:
        try:
            _init_api()
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            shell32 = ctypes.WinDLL("shell32", use_last_error=True)
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

            hinstance = kernel32.GetModuleHandleW(None)
            self._taskbar_created = user32.RegisterWindowMessageW("TaskbarCreated")

            wndproc = WNDPROC(self._wnd_proc)
            cls = _WNDCLASS()
            cls.lpfnWndProc = wndproc
            cls.hInstance = hinstance
            cls.lpszClassName = "SgoDiaryTrayWindow"
            if not user32.RegisterClassW(ctypes.byref(cls)):
                log.warning("Не удалось зарегистрировать класс окна трея: %s",
                            ctypes.get_last_error())
                return

            self._hwnd = user32.CreateWindowExW(
                0, "SgoDiaryTrayWindow", "Дневник СГО", 0,
                0, 0, 0, 0, None, None, hinstance, None,
            )
            if not self._hwnd:
                log.warning("Не удалось создать окно трея: %s", ctypes.get_last_error())
                return

            self._icon = user32.LoadImageW(
                None, self.icon_path, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE
            )
            if not self._icon:
                log.warning("Не удалось загрузить значок %s", self.icon_path)

            nid = _NOTIFYICONDATA()
            nid.cbSize = ctypes.sizeof(_NOTIFYICONDATA)
            nid.hWnd = self._hwnd
            nid.uID = IDI_TRAY_ID
            nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
            nid.uCallbackMessage = WM_TRAY
            nid.hIcon = self._icon
            nid.szTip = self.tip[:127]
            self._nid = nid

            if not shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(nid)):
                log.warning("Значок не появился в трее: %s", ctypes.get_last_error())
                return

            self._ready.set()
            log.info("Значок в трее создан")

            msg = _MSG()
            while not self._stop.is_set():
                result = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if result in (0, -1):
                    break
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        except Exception:
            log.exception("Ошибка потока трея")
        finally:
            self._ready.clear()
            try:
                if self._nid is not None and _SHELL32 is not None:
                    _SHELL32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(self._nid))
            except Exception:
                pass

    def _wnd_proc(self, hwnd, message, wparam, lparam):
        user32 = _USER32
        if user32 is None:
            return 0
        try:
            if message == WM_TRAY:
                event = lparam & 0xFFFF
                if event == WM_LBUTTONUP or event == WM_LBUTTONDBLCLK:
                    self._call(self.on_open)
                elif event == WM_RBUTTONUP or event == WM_CONTEXTMENU:
                    self._show_menu()
                return 0
            if message == WM_COMMAND:
                cmd = int(wparam) & 0xFFFF
                self._handle_command(cmd)
                return 0
            if message == self._taskbar_created and self._taskbar_created:
                # Проводник перезапустился — возвращаем значок в трей.
                try:
                    shell32 = ctypes.WinDLL("shell32")
                    if self._nid is not None:
                        shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(self._nid))
                except Exception:
                    pass
                return 0
            if message == WM_DESTROY:
                user32.PostQuitMessage(0)
                return 0
        except Exception:
            log.exception("Ошибка обработки сообщения трея")
        return user32.DefWindowProcW(hwnd, message, wparam, lparam)

    def _handle_command(self, cmd: int) -> None:
        if cmd == CMD_OPEN:
            self._call(self.on_open)
        elif cmd == CMD_REFRESH:
            self._call(self.on_refresh)
        elif cmd == CMD_TOGGLE_BACKGROUND:
            self.background_on = not self.background_on
            self._call(self.on_toggle_background, self.background_on)
        elif cmd == CMD_TOGGLE_NOTIFICATIONS:
            self.notifications_on = not self.notifications_on
            self._call(self.on_toggle_notifications, self.notifications_on)
        elif cmd == CMD_TOGGLE_AUTOSTART:
            self.autostart_on = not self.autostart_on
            self._call(self.on_toggle_autostart, self.autostart_on)
        elif cmd == CMD_QUIT:
            self._call(self.on_quit)

    def _call(self, func: Optional[Callable], *args) -> None:
        if not func:
            return
        try:
            func(*args)
        except Exception:
            log.exception("Ошибка обработчика трея")

    def _show_menu(self) -> None:
        user32 = _USER32
        if user32 is None:
            return
        try:
            menu = user32.CreatePopupMenu()
            user32.AppendMenuW(menu, MF_STRING, CMD_OPEN, "Открыть дневник")
            user32.AppendMenuW(menu, MF_STRING, CMD_REFRESH, "Обновить сейчас")
            user32.AppendMenuW(menu, MF_SEPARATOR, 0, None)
            user32.AppendMenuW(
                menu, MF_STRING | (MF_CHECKED if self.background_on else 0),
                CMD_TOGGLE_BACKGROUND, "Фоновые обновления"
            )
            user32.AppendMenuW(
                menu, MF_STRING | (MF_CHECKED if self.notifications_on else 0),
                CMD_TOGGLE_NOTIFICATIONS, "Уведомления"
            )
            if self.autostart_available:
                user32.AppendMenuW(
                    menu, MF_STRING | (MF_CHECKED if self.autostart_on else 0),
                    CMD_TOGGLE_AUTOSTART, "Автозапуск с Windows"
                )
            user32.AppendMenuW(menu, MF_SEPARATOR, 0, None)
            user32.AppendMenuW(menu, MF_STRING, CMD_QUIT, "Выход")

            pt = wt.POINT()
            user32.GetCursorPos(ctypes.byref(pt))
            user32.SetForegroundWindow(self._hwnd)
            cmd = user32.TrackPopupMenu(
                menu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                pt.x, pt.y, 0, self._hwnd, None
            )
            user32.PostMessageW(self._hwnd, 0, 0, 0)  # сброс фокуса
            user32.DestroyMenu(menu)
            if cmd:
                self._handle_command(int(cmd))
        except Exception:
            log.exception("Не удалось показать меню трея")

    def _modify(self) -> None:
        if _SHELL32 is None or self._nid is None:
            return
        _SHELL32.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(self._nid))

    def _show_balloon(self, title: str, message: str) -> None:
        if self._nid is None:
            return
        self._nid.uFlags = NIF_INFO
        self._nid.szInfoTitle = (title or "")[:63]
        self._nid.szInfo = (message or "")[:255]
        self._nid.dwInfoFlags = NIIF_INFO
        self._modify()
        # Через несколько секунд убираем текст, чтобы «пузырь» не висел.
        threading.Timer(6.0, self._clear_balloon).start()

    def _clear_balloon(self) -> None:
        try:
            if self._nid is None:
                return
            self._nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
            self._nid.szInfo = ""
            self._nid.szInfoTitle = ""
            self._modify()
        except Exception:
            pass


def resource_path(*parts: str) -> str:
    """Путь к ресурсу с учётом сборки PyInstaller (одиночный .exe)."""
    base = getattr(__import__("sys"), "_MEIPASS", None)
    if base:
        return os.path.join(base, *parts)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), *parts)
