# -*- coding: utf-8 -*-
"""Фоновый наблюдатель: следит за дневником и сообщает о новом.

Работает в отдельном потоке: с заданным интервалом запрашивает у СГО
дневник (текущая и следующая неделя), сравнивает с сохранённым состоянием
и показывает уведомления о новых оценках и домашних заданиях.

Особенности:
  * первая проверка только запоминает текущее состояние (без «взлёта»
    уведомлений за всё прошлое);
  * при обрыве связи ничего не теряется — состояние не перезаписывается,
    следующая попытка будет обычной;
  * интервал и флаги уведомлений читаются из настроек при каждом цикле,
    поэтому смена интервала применяется без перезапуска.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import sgo_homework as core
import sgo_settings
import sgo_web

log = logging.getLogger("sgo.watcher")

STATE_NAME = "sgo_watcher.json"
MAX_WEEKS = 6
MAX_NOTIFICATIONS_PER_CYCLE = 3


def _state_path() -> Path:
    return core.config_dir() / STATE_NAME


def _week_key(day: date) -> str:
    monday = day - timedelta(days=day.weekday())
    return monday.isoformat()


def _load_state() -> Dict[str, Any]:
    try:
        data = json.loads(_state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_state(state: Dict[str, Any]) -> None:
    path = _state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        log.warning("Не удалось сохранить состояние наблюдателя: %s", exc)


def _mark_key(subject: str, mark: Dict[str, Any]) -> str:
    ident = mark.get("id")
    if ident not in (None, "", 0):
        return f"m:{ident}"
    return "|".join([
        "m", str(subject or ""), str(mark.get("date") or "")[:10],
        str(mark.get("value") or ""), str(mark.get("topic") or ""),
    ])


def _task_key(day_date: str, lesson_number: Any, task: Dict[str, Any]) -> str:
    ident = task.get("id")
    stable = f"id:{ident}" if ident not in (None, "", 0) else f"text:{str(task.get('text') or '').strip()}"
    return f"t|{day_date}|{lesson_number if lesson_number is not None else ''}|{stable}"


def collect_items(diary: Dict[str, Any]) -> Tuple[Dict[str, List[str]], Dict[str, List[str]]]:
    """Разбирает дневник на «известные» отметки и задания.

    Возвращает (week -> [ключи отметок], week -> [ключи заданий]).
    """
    marks: Dict[str, List[str]] = {}
    tasks: Dict[str, List[str]] = {}

    for day in diary.get("days") or []:
        day_date = str(day.get("date") or "")[:10]
        if not day_date:
            continue
        try:
            week = _week_key(date.fromisoformat(day_date))
        except ValueError:
            continue

        for lesson in day.get("lessons") or []:
            subject = str(lesson.get("subject") or "")
            number = lesson.get("number")

            for mark in lesson.get("marks") or []:
                marks.setdefault(week, []).append(_mark_key(subject, mark))

            for task in lesson.get("tasks") or []:
                text = str(task.get("text") or "").strip()
                if not text:
                    continue
                tasks.setdefault(week, []).append(_task_key(day_date, number, task))

    for week in list(marks):
        marks[week] = sorted(set(marks[week]))
    for week in list(tasks):
        tasks[week] = sorted(set(tasks[week]))
    return marks, tasks


def diff_weeks(
    weeks: Dict[str, Any],
    marks: Dict[str, List[str]],
    tasks: Dict[str, List[str]],
) -> Tuple[List[str], List[str]]:
    """Ищет новые ключи относительно сохранённого состояния.

    Неделя, которой ещё не было в состоянии, молча пропускается: при первом
    запуске (или при смене недели) уведомлять обо всём старом не надо.
    """
    new_marks: List[str] = []
    new_tasks: List[str] = []

    for week, keys in marks.items():
        if week not in weeks:
            continue
        previous = set((weeks.get(week) or {}).get("marks") or [])
        new_marks.extend(key for key in keys if key not in previous)

    for week, keys in tasks.items():
        if week not in weeks:
            continue
        previous = set((weeks.get(week) or {}).get("tasks") or [])
        new_tasks.extend(key for key in keys if key not in previous)

    return new_marks, new_tasks


def _describe_mark(subject: str, mark: Dict[str, Any]) -> str:
    value = str(mark.get("value") or "").strip()
    topic = str(mark.get("topic") or mark.get("type") or "").strip()
    parts = [part for part in (value, subject) if part]
    text = " · ".join(parts)
    if topic:
        text += f" — {topic}"
    return text


def _describe_task(subject: str, task: Dict[str, Any]) -> str:
    text = str(task.get("text") or "").strip()
    return f"{subject}: {text}" if subject else text


class Watcher:
    """Следит за дневником в фоне и сообщает о новом."""

    def __init__(
        self,
        state: "sgo_web.AppState",
        notifier: Optional[Callable[[str, str], None]] = None,
        on_update: Optional[Callable[[], None]] = None,
    ) -> None:
        self.state = state
        self.notifier = notifier
        self.on_update = on_update
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._last_error = ""

    # --- Управление ---
    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="sgo-watcher", daemon=True)
        self._thread.start()
        log.info("Фоновый наблюдатель запущен")

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def wake(self) -> None:
        """Просит проверить данные как можно скорее."""
        self._wake.set()

    def check_now(self) -> int:
        """Одна проверка вне цикла. Возвращает число новых находок."""
        return self._check()

    # --- Внутреннее ---
    def _run(self) -> None:
        # Первая проверка — сразу после старта, дальше по интервалу.
        while not self._stop.is_set():
            if sgo_settings.background_enabled():
                try:
                    self._check()
                except Exception:
                    log.exception("Фоновая проверка не удалась")
            delay = max(30, sgo_settings.interval_minutes() * 60)
            # Ждём, но просыпаемся досрочно по требованию.
            self._wake.wait(timeout=delay)
            self._wake.clear()

    def _check(self) -> int:
        """Одна проверка: опрос дневника и поиск нового."""
        if not sgo_settings.background_enabled():
            return 0

        monday = date.today() - timedelta(days=date.today().weekday())
        # Текущая и следующая неделя: домашка на завтра может быть уже там.
        end = monday + timedelta(days=13)

        try:
            with self.state.lock:
                self.state.connect()
                client = self.state.client
                if client is None or client.student_id is None:
                    return 0
                raw = client.diary_range(monday, end)
        except Exception as exc:
            message = str(exc)
            if message != self._last_error:
                self._last_error = message
                log.warning("Фоновая проверка: %s", message)
            # Сессия СГО протухла — сбрасываем, чтобы следующий цикл вошёл заново.
            if "авторизован" in message.lower() or "401" in message:
                try:
                    self.state.reset()
                except Exception:
                    pass
            return 0

        self._last_error = ""
        diary = _normalise_diary(raw)
        marks, tasks = collect_items(diary)

        state = _load_state()
        weeks = state.get("weeks")
        if not isinstance(weeks, dict):
            weeks = {}

        found_marks, found_tasks = diff_weeks(weeks, marks, tasks)
        details_marks = [_describe_mark_for(diary, key) for key in found_marks]
        details_tasks = [_describe_task_for(diary, key) for key in found_tasks]

        # Сохраняем новое состояние (даже если уведомления выключены).
        for week in set(list(marks.keys()) + list(tasks.keys())):
            entry = weeks.get(week)
            if not isinstance(entry, dict):
                entry = {}
            entry["marks"] = marks.get(week, [])
            entry["tasks"] = tasks.get(week, [])
            weeks[week] = entry

        # Храним только последние недели.
        if len(weeks) > MAX_WEEKS:
            for old in sorted(weeks.keys())[:-MAX_WEEKS]:
                weeks.pop(old, None)
        state["weeks"] = weeks
        _save_state(state)

        total = len(found_marks) + len(found_tasks)
        if total:
            if self.notifier:
                self._notify(found_marks, found_tasks, details_marks, details_tasks)
            # Окно обновляем только когда действительно есть что показать.
            if self.on_update:
                try:
                    self.on_update()
                except Exception:
                    log.exception("Ошибка обработчика обновления")
        return total

    def _notify(
        self,
        marks: List[str],
        tasks: List[str],
        mark_details: List[str],
        task_details: List[str],
    ) -> None:
        """Показывает уведомления. Не больше MAX_NOTIFICATIONS_PER_CYCLE за раз."""
        if not self.notifier:
            return

        queue: List[Tuple[str, str]] = []
        if sgo_settings.notify_marks_enabled():
            queue.extend(("Новая оценка", detail) for detail in mark_details)
        if sgo_settings.notify_homework_enabled():
            queue.extend(("Новое домашнее задание", detail) for detail in task_details)

        if not queue:
            return

        shown = queue[:MAX_NOTIFICATIONS_PER_CYCLE]
        for title, detail in shown:
            try:
                self.notifier(title, detail)
            except Exception:
                log.exception("Не удалось показать уведомление")

        if len(queue) > len(shown):
            try:
                self.notifier(
                    "Дневник обновлён",
                    f"Ещё новых записей: {len(queue) - len(shown)}",
                )
            except Exception:
                log.exception("Не удалось показать уведомление")


def _normalise_diary(raw: Any) -> Dict[str, Any]:
    """Приводит ответ СГО к виду, который использует sgo_web.diary_data."""
    if not isinstance(raw, dict):
        return {"days": []}
    days = raw.get("weekDays") or raw.get("days") or []
    out_days = []
    for day in days:
        if not isinstance(day, dict):
            continue
        lessons = []
        for lesson in day.get("lessons") or []:
            if not isinstance(lesson, dict):
                continue
            marks = []
            for assignment in lesson.get("assignments") or []:
                if not isinstance(assignment, dict):
                    continue
                mark = assignment.get("mark")
                if not isinstance(mark, dict) or not mark.get("mark"):
                    continue
                marks.append({
                    "id": assignment.get("id"),
                    "value": str(mark.get("mark")),
                    "date": mark.get("date") or day.get("date"),
                    "topic": str(assignment.get("assignmentName") or ""),
                    "type": str(assignment.get("typeName") or ""),
                })
            tasks = []
            for assignment in lesson.get("assignments") or []:
                if not isinstance(assignment, dict):
                    continue
                text = str(assignment.get("assignmentName") or "").strip()
                if not text:
                    continue
                # Задание с уже выставленной отметкой — это не «новое ДЗ»:
                # о нём сообщит уведомление об оценке.
                if isinstance(assignment.get("mark"), dict) and assignment["mark"].get("mark"):
                    continue
                tasks.append({
                    "id": assignment.get("id"),
                    "text": text,
                    "type": str(assignment.get("typeName") or ""),
                })
            lessons.append({
                "number": lesson.get("number"),
                "subject": str(lesson.get("subjectName") or ""),
                "room": str(lesson.get("room") or ""),
                "start": str(lesson.get("startTime") or "")[:5],
                "end": str(lesson.get("endTime") or "")[:5],
                "marks": marks,
                "tasks": tasks,
            })
        out_days.append({
            "date": str(day.get("date") or "")[:10],
            "weekday": str(day.get("weekDay") or day.get("weekday") or ""),
            "lessons": lessons,
        })
    return {"days": out_days}


def _describe_mark_for(diary: Dict[str, Any], key: str) -> str:
    """Ищет отметку по ключу и собирает текст уведомления."""
    for day in diary.get("days") or []:
        for lesson in day.get("lessons") or []:
            for mark in lesson.get("marks") or []:
                if _mark_key(lesson.get("subject") or "", mark) == key:
                    return _describe_mark(lesson.get("subject") or "", mark)
    return "Новая отметка"


def _describe_task_for(diary: Dict[str, Any], key: str) -> str:
    for day in diary.get("days") or []:
        for lesson in day.get("lessons") or []:
            for task in lesson.get("tasks") or []:
                if _task_key(day.get("date") or "", lesson.get("number"), task) == key:
                    return _describe_task(lesson.get("subject") or "", task)
    return "Новое задание"
