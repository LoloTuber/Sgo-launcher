# -*- coding: utf-8 -*-
"""Локальный веб-интерфейс для дневника «Сетевой город»."""

import argparse
import base64
import json
import mimetypes
import os
import platform
import re
import socket
import sys
import threading
import time
import traceback
import webbrowser
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

import sgo_homework as core
from sgo_reports import (
    ATTENDANCE_CODES,
    NOT_ABSENCE_CODES,
    ReportError,
    ReportService,
    parse_student_total,
)

# Поиск файлов внутри собранного EXE
def resource_path(relative_path):
    try:
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

WEB_ROOT = Path(resource_path("web"))

# Версия приложения: показывается в служебном режиме.
APP_VERSION = "1.4.1"
APP_BUILD = "2026-11-25"

_WEEKDAYS = ("понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье")
_MONTHS_GENITIVE = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")

# Кэш дневника по неделям: нужен, чтобы предзагруженные недели
# открывались мгновенно и не дёргали сервер СГО заново.
DIARY_CACHE_TTL = 600  # 10 минут
_diary_cache: Dict[str, Dict[str, Any]] = {}
_diary_cache_time: Dict[str, float] = {}
_diary_cache_lock = threading.Lock()
_preload_lock = threading.Lock()
_preload_running = False

# Кэш подробностей заданий: по клику на оценку подробности открываются
# сразу, без повторного запроса в СГО.
DETAILS_CACHE_TTL = 1800  # 30 минут
_details_cache: Dict[int, tuple] = {}
_details_cache_lock = threading.Lock()
# Пауза между принудительными перечитываниями одной недели: чтобы
# «След. неделя» не превращалась в частые запросы к СГО.
FORCE_DIARY_COOLDOWN = 60  # секунд
_diary_forced_at: Dict[str, float] = {}

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

def ru_date(value: date) -> str:
    return f"{value.day} {_MONTHS_GENITIVE[value.month - 1]}, {_WEEKDAYS[value.weekday()]}"

def _as_date(value: Any) -> Optional[date]:
    if not value: return None
    try: return datetime.fromisoformat(str(value)[:19]).date()
    except ValueError: return None

class AppState:
    def __init__(self, config: Dict[str, Any]) -> None:
        self.config = config
        self.lock = threading.RLock()
        self.client: Optional[core.SgoClient] = None
        self.reports: Optional[ReportService] = None
        self._cache: Dict[str, tuple] = {}
        self._report_failures: Dict[str, tuple] = {}

    def connect(self) -> None:
        if self.client is not None: return
        login = str(self.config.get("login") or "")
        password = str(self.config.get("password") or "")
        if not login or not password:
            raise RuntimeError("Не авторизован")
        url = str(self.config.get("url") or core.DEFAULT_URL)
        school = str(self.config.get("school_id") or self.config.get("school") or "")
        client = core.SgoClient(url)
        client.login(login, password, school)
        self.client = client
        self.reports = ReportService(client)

    def reset(self) -> None:
        with self.lock:
            self.client = None
            self.reports = None
            self._cache.clear()
            self._report_failures.clear()

    def cached(self, key: str, ttl: float, producer: Callable[[], Any]) -> Any:
        now = time.time()
        entry = self._cache.get(key)
        if entry and now - entry[0] < ttl: return entry[1]
        value = producer()
        self._cache[key] = (now, value)
        return value

    def remember(self, key: str, value: Any) -> None:
        """Запоминает значение как «последнее удачное» (без срока годности)."""
        self._cache[key] = (time.time(), value)

    def last_good(self, key: str) -> Any:
        """Последнее удачное значение или None."""
        entry = self._cache.get(key)
        return entry[1] if entry else None

    def note_report_failure(self, key: str, error: str) -> None:
        """Запоминает неудачу запроса отчёта, чтобы не долбить СГО подряд."""
        self._report_failures[key] = (time.time(), error)

    def recent_report_failure(self, key: str, window: float = 60.0) -> Optional[str]:
        """Текст последней ошибки отчёта, если она была совсем недавно."""
        entry = self._report_failures.get(key)
        if entry and time.time() - entry[0] < window:
            return entry[1]
        return None

def dashboard_data(state: AppState) -> Dict[str, Any]:
    with state.lock:
        state.connect()
        def producer() -> Dict[str, Any]:
            return state.client.get("student-diary/dashboard", params={"studentId": state.client.student_id, "version": 2})
        return state.cached("dashboard", 300, producer)

def get_vacation_info(dashboard: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    vacations = dashboard.get("vacations") or []
    today = date.today()
    upcoming = []
    for v in vacations:
        start = _as_date(v.get("startDate"))
        if start and start >= today:
            upcoming.append({"name": v.get("name") or "Каникулы", "start": start.isoformat(), "days": (start - today).days})
    if upcoming:
        upcoming.sort(key=lambda x: x["start"])
        return upcoming[0]
    return None

def student_info(state: AppState, dashboard: Dict[str, Any]) -> Dict[str, Any]:
    client = state.client
    averages = dashboard.get("averageMarks") or {}
    return {
        "name": client.student_name if client else "", "class": dashboard.get("className") or "",
        "term": dashboard.get("termName") or "", "termStart": dashboard.get("termStartDate") or "",
        "termEnd": dashboard.get("termEndDate") or "", "average": averages.get("commonAverageMark"),
        "vacation": get_vacation_info(dashboard),
    }

def results_data(dashboard: Dict[str, Any]) -> Dict[str, Any]:
    averages = dashboard.get("averageMarks") or {}
    subjects = []
    for item in averages.get("subjectAverageMarks") or []:
        if isinstance(item, dict):
            subjects.append({"name": item.get("subjectName") or "", "average": item.get("averageMark")})
    subjects.sort(key=lambda item: item["name"])
    return {
        "common": averages.get("commonAverageMark"),
        "subjects": subjects,
        "term": dashboard.get("termName") or "",
        "mode": "current",
        "finalAvailable": False,
    }


def _parse_average(value: Any) -> Optional[float]:
    """'4,35' / '4.35' / 4.35 -> float; пустое или нечисловое -> None."""
    text = str(value or "").strip().replace(",", ".")
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    return round(number, 2)


def _marks_weighted_average(item: Dict[str, Any],
                            weights_index: Optional[Dict[tuple, List[Dict[str, Any]]]]) -> tuple:
    """Собственное взвешенное среднее предмета: (среднее, сумма весов).

    Долг («.»/«-») считается как «2», вес оценки берётся из дневника.
    """
    name = (item.get("name") or "").strip()
    total = 0.0
    weights = 0.0
    for m in item.get("marks") or []:
        value = m.get("value")
        number = _mark_number(value)
        if number is None:
            continue
        weight = 1
        if weights_index:
            info = _take_mark_info(
                weights_index, name, str(m.get("date") or "")[:10], _mark_value(value)
            ) or {}
            weight = info.get("weight") or 1
        total += number * weight
        weights += weight
    return (round(total / weights, 2) if weights else None, weights)


def _results_from_parsed(parsed: Dict[str, Any], term_label: str, mode: str,
                         weights_index: Optional[Dict[tuple, List[Dict[str, Any]]]] = None) -> Dict[str, Any]:
    """Собирает список «Итогов» из распарсенного отчёта StudentTotal.

    mode="year" — годовые отметки (последняя колонка таблицы);
    mode="current" — средние баллы за выбранный триместр/период.

    Средние из отчёта СГО (average / termAverage / final) не перезаписываются.
    Общий балл в режиме «current» считаем сами — взвешенно, с учётом весов
    оценок (10/15/20/30) и долга как «2».
    """
    subjects = []
    weighted_sum = 0.0
    weight_total = 0.0
    finals_present = 0
    for item in parsed.get("subjects") or []:
        name = (item.get("name") or "").strip()
        if not name:
            continue
        final_value = _parse_average(item.get("final"))
        average_value = _parse_average(item.get("average"))
        marks_count = len([m for m in item.get("marks") or [] if _parse_average(m.get("value")) is not None])
        own_average, own_weight = _marks_weighted_average(item, weights_index)
        if final_value is not None:
            finals_present += 1
        value = final_value if mode == "year" else average_value
        subjects.append({
            "name": name,
            "average": value,
            "final": final_value,
            "termAverage": average_value,
            "marksCount": marks_count,
            # Собственное взвешенное среднее и «вес» предмета (сумма весов оценок).
            "weightedAverage": own_average,
            "weight": own_weight,
        })
        if mode == "year":
            # Годовая отметка — одна оценка на предмет, вес не применим.
            if value is not None:
                weighted_sum += value
                weight_total += 1
        elif own_average is not None:
            weighted_sum += own_average * own_weight
            weight_total += own_weight
        elif value is not None:
            weight = marks_count or 1
            weighted_sum += value * weight
            weight_total += weight
    subjects.sort(key=lambda item: item["name"])
    common = round(weighted_sum / weight_total, 2) if weight_total else None
    return {
        "common": common,
        "subjects": subjects,
        "term": parsed.get("term") or term_label or "",
        "mode": mode,
        "finalAvailable": finals_present > 0,
        "asOf": parsed.get("as_of") or "",
    }


def results_by_term_data(state: AppState, term_id: Optional[str], mode: str = "current") -> Dict[str, Any]:
    """Итоги за выбранный учебный период (триместр) или годовые отметки."""
    with state.lock:
        state.connect()
        dash = dashboard_data(state)
        current_term_id = str(dash.get("termId") or "")
        current_term_name = str(dash.get("termName") or "")

        overrides = _term_overrides(state, term_id)
        try:
            def producer():
                html = state.reports.generate_html("StudentTotal", overrides)
                return parse_student_total(html)
            report_key = f"report:studenttotal:{term_id or 'current'}"
            # Не долбим СГО, если предыдущий запрос отчёта недавно упал.
            recent = state.recent_report_failure(report_key)
            if recent:
                raise ReportError(recent)
            try:
                parsed = state.cached(report_key, 600, producer)
            except Exception as exc:
                state.note_report_failure(report_key, str(exc))
                raise
        except Exception as exc:
            traceback.print_exc()
            print(f"! StudentTotal ({term_id=}) failed: {exc}", file=sys.stderr)

            # Если запрошен НЕ текущий период и отчёт не строится —
            # НЕ подставляем данные дашборда (это будет вводить в заблуждение,
            # потому что дашборд всегда показывает ТЕКУЩИЙ триместр).
            if term_id and current_term_id and term_id != current_term_id:
                return {
                    "common": None,
                    "subjects": [],
                    "term": "",
                    "mode": "year" if mode == "year" else "current",
                    "finalAvailable": False,
                    "asOf": "",
                    "requestedTermId": term_id,
                    "error": (
                        f"Отчёт за выбранный период недоступен. "
                        f"Скорее всего, этот триместр ещё не начался. ({exc})"
                    ),
                }

            # Для текущего периода fallback на дашборд допустим.
            data = results_data(dash)
            data["error"] = f"Не удалось получить отчёт за выбранный период: {exc}"
            data["requestedTermId"] = term_id
            return data

        label = current_term_name
        if term_id:
            try:
                for src in state.reports.info("StudentTotal").get("filterSources") or []:
                    if src.get("filterId") == "TERMID":
                        for item in src.get("items") or []:
                            if str(item.get("value")) == str(term_id):
                                label = str(item.get("title") or "")
            except Exception:
                pass

        # Веса оценок для взвешенного общего балла: берём их из дневника,
        # в отчёте StudentTotal весов нет.
        weights = {}
        try:
            start, end = _term_range(parsed, dash)
            weights = _weights_index(state, start, end)
        except Exception as exc:
            traceback.print_exc()
            print(f"! Не удалось получить веса оценок для итогов: {exc}", file=sys.stderr)
            weights = {}

        result = _results_from_parsed(parsed, label, "year" if mode == "year" else "current", weights)

        # Проверяем, что сервер действительно вернул запрошенный период.
        if term_id and result.get("term") and str(result["term"]).strip() != str(label).strip():
            print(
                f"! StudentTotal: запрошен термин {term_id!r} ({label!r}), "
                f"а отчёт вернул {result['term']!r}. Возможно, фильтр не применился.",
                file=sys.stderr,
            )
            result["warning"] = (
                f"Сервер вернул отчёт за «{result['term']}», "
                f"хотя запрошен «{label}». Возможно, этот период не поддерживается."
            )
        result["requestedTermId"] = term_id
        try:
            period = term_period_ranges(state).get(str(term_id or "")) if term_id else None
        except Exception:
            period = None
        if period:
            result["termStart"] = period[0].isoformat()
            result["termEnd"] = period[1].isoformat()
        return result


def lessons_for(state: AppState, day: date) -> List[Dict[str, Any]]:
    monday = day - timedelta(days=day.weekday())
    cache_key = "diary:" + monday.isoformat()
    with state.lock:
        state.connect()
        diary = state.cached(cache_key, 600, lambda: state.client.diary(monday))
    return core.lessons_for_day(diary, day, state.client._assignment_types or {}) or []

def _find_school_day(state: AppState, start: date, days: int = 8) -> tuple:
    for offset in range(days):
        day = start + timedelta(days=offset)
        lessons = lessons_for(state, day)
        if lessons: return day, lessons
    return start, []

def homework_data(state: AppState, target: Optional[date] = None) -> Dict[str, Any]:
    tomorrow = date.today() + timedelta(days=1)
    day, lessons = _find_school_day(state, target or tomorrow, 1 if target else 8)
    collected = core.collect(lessons, state.client) if lessons else []
    payload = []
    for lesson in collected:
        tasks = [t for t in lesson.get("tasks") or [] if t.get("text") or t.get("details")]
        payload.append({
            "number": lesson.get("number"), "subject": lesson.get("subject") or "",
            "room": lesson.get("room") or "", "start": lesson.get("start") or "",
            "end": lesson.get("end") or "", "tasks": tasks,
        })
    note = "Завтра уроков нет — показываю ближайший учебный день." if target is None and day != tomorrow else ""
    return {
        "date": day.isoformat(), "label": ru_date(day), "isTomorrow": day == tomorrow,
        "note": note, "lessons": payload, "tasksCount": sum(len(i["tasks"]) for i in payload),
    }

def diary_data(state: AppState, week_start: Optional[str] = None, force: bool = False) -> Dict[str, Any]:
    if week_start:
        try: d = date.fromisoformat(week_start)
        except ValueError: d = date.today()
    else: d = date.today()
    monday = d - timedelta(days=d.weekday())
    key = monday.isoformat()

    # Свежая копия из кэша — мгновенный ответ без запроса в СГО.
    # force=True — читаем неделю заново (переход по «След. неделя»),
    # но не чаще раза в минуту, чтобы не долбить сервер.
    now = time.time()
    with _diary_cache_lock:
        stamp = _diary_cache_time.get(key, 0)
        cached = _diary_cache.get(key)
        last_forced = _diary_forced_at.get(key, 0)
        if force and (now - last_forced) < FORCE_DIARY_COOLDOWN:
            force = False
        if cached is not None and not force and (now - stamp) < DIARY_CACHE_TTL:
            return cached
        if force:
            _diary_forced_at[key] = now

    with state.lock:
        state.connect()
        diary = state.client.diary(monday)

    days = []
    for day in diary.get("weekDays") or []:
        day_date = _as_date(day.get("date"))
        if not day_date: continue
        lessons_out = []
        for lesson in day.get("lessons") or []:
            tasks = []
            marks = []
            for a in lesson.get("assignments") or []:
                text = core._clean_text(a.get("assignmentName") or "")
                if not core._is_empty_task(text):
                    tasks.append({"id": a.get("id"), "text": text, "type": a.get("typeName") or ""})
                m = a.get("mark")
                if isinstance(m, dict) and m.get("mark"):
                    marks.append({
                        "id": a.get("id"), "value": str(m.get("mark")),
                        "date": m.get("date") or day.get("date"), "topic": text,
                        "type": a.get("typeName") or "", "weight": a.get("weight") or 1
                    })
            lessons_out.append({
                "number": lesson.get("number"), "subject": (lesson.get("subjectName") or "").strip(),
                "room": lesson.get("room") or "", "start": (lesson.get("startTime") or "")[:5],
                "end": (lesson.get("endTime") or "")[:5], "tasks": tasks, "marks": marks
            })
        days.append({"date": day_date.isoformat(), "weekday": _WEEKDAYS[day_date.weekday()], "lessons": lessons_out})
    days.sort(key=lambda x: x["date"])
    result = {"weekStart": monday.isoformat(), "weekEnd": (monday + timedelta(days=6)).isoformat(), "days": days}

    with _diary_cache_lock:
        _diary_cache[key] = result
        _diary_cache_time[key] = time.time()
    return result


def clear_diary_cache() -> None:
    """Сбрасывает кэш дневника и подробностей — например, после ручного обновления."""
    with _diary_cache_lock:
        _diary_cache.clear()
        _diary_cache_time.clear()
        _diary_forced_at.clear()
    clear_details_cache()


def preload_diary(state: AppState, weeks: int = 2) -> int:
    """Заранее загружает дневник на weeks недель назад и вперёд.

    Делается в фоне и последним: основные экраны должны загрузиться раньше.
    """
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    loaded = 0
    for offset in range(-weeks, weeks + 1):
        if offset == 0:
            continue
        target = monday + timedelta(days=7 * offset)
        try:
            diary_data(state, target.isoformat())
            loaded += 1
        except Exception as exc:
            print(f"! предзагрузка дневника ({target.isoformat()}) не удалась: {exc}", file=sys.stderr)
    return loaded


def start_diary_preload(state: AppState, weeks: int = 2) -> bool:
    """Запускает предзагрузку в отдельном потоке. True — если уже шла."""
    global _preload_running
    with _preload_lock:
        if _preload_running:
            return False
        _preload_running = True

    def worker() -> None:
        global _preload_running
        try:
            preload_diary(state, weeks)
        except Exception as exc:
            print(f"! предзагрузка дневника не удалась: {exc}", file=sys.stderr)
        finally:
            with _preload_lock:
                _preload_running = False

    threading.Thread(target=worker, name="sgo-preload", daemon=True).start()
    return True


def schedule_data(state: AppState, week_start: Optional[str] = None) -> Dict[str, Any]:
    if week_start:
        try: d = date.fromisoformat(week_start)
        except ValueError: d = date.today()
    else: d = date.today()
    monday = d - timedelta(days=d.weekday())
    with state.lock:
        state.connect()
        diary = state.client.diary(monday)
    days = []
    for day in diary.get("weekDays") or []:
        day_date = _as_date(day.get("date"))
        if not day_date: continue
        lessons_out = []
        for lesson in day.get("lessons") or []:
            lessons_out.append({
                "number": lesson.get("number"), "subject": (lesson.get("subjectName") or "").strip(),
                "room": lesson.get("room") or "", "start": (lesson.get("startTime") or "")[:5], "end": (lesson.get("endTime") or "")[:5],
            })
        days.append({"date": day_date.isoformat(), "weekday": _WEEKDAYS[day_date.weekday()], "lessons": lessons_out})
    days.sort(key=lambda x: x["date"])
    return {"weekStart": monday.isoformat(), "weekEnd": (monday + timedelta(days=6)).isoformat(), "days": days}

def _term_list(state: AppState) -> List[Dict[str, str]]:
    """Все учебные периоды из filterSources отчёта StudentTotal (хронологически).

    Сразу после логина СГО иногда возвращает пустой filterSources — делаем
    один retry через 500 мс.
    """
    sources: List[Dict[str, Any]] = []
    try:
        sources = (state.client.get("reports/StudentTotal") or {}).get("filterSources") or []
    except Exception:
        sources = []
    if not sources:
        time.sleep(0.5)
        try:
            sources = (state.client.get("reports/StudentTotal") or {}).get("filterSources") or []
        except Exception:
            sources = []

    result: List[Dict[str, str]] = []
    for src in sources:
        if src.get("filterId") != "TERMID":
            continue
        for item in src.get("items") or []:
            value = str(item.get("value") or "").strip()
            if not value or value == "-1":
                continue
            result.append({"id": value, "name": str(item.get("title") or "")})
        break
    return result


def terms_data(state: AppState) -> List[Dict[str, str]]:
    """Список учебных периодов для UI. Только до текущего включительно.

    Важно:
    - СГО отдаёт и будущие триместры (2, 3), но для них отчёт StudentTotal
      не строится (queue возвращает taskId=-1). UI не должен их показывать,
      иначе пользователь видит данные текущего триместра под видом «2 триместр».
    - «-1 — Произвольный интервал» тоже убираем: это не период, а спец-опция.
    """
    with state.lock:
        state.connect()
        all_terms = _term_list(state)

        # Текущий триместр из дашборда
        current_id = ""
        current_name = ""
        try:
            dash = dashboard_data(state)
            current_id = str(dash.get("termId") or "")
            current_name = str(dash.get("termName") or "")
        except Exception:
            pass

        if all_terms:
            if current_id:
                cutoff = -1
                for i, t in enumerate(all_terms):
                    if t["id"] == current_id:
                        cutoff = i
                        break
                if cutoff >= 0:
                    all_terms = all_terms[: cutoff + 1]
        elif current_id:
            all_terms = [{"id": current_id, "name": current_name or "Текущий период"}]
        else:
            return []

        # Даты периода — чтобы в интерфейсе было видно, за какой именно
        # отрезок времени пришли данные.
        try:
            ranges = term_period_ranges(state)
        except Exception:
            ranges = {}
        for term in all_terms:
            period = ranges.get(term["id"])
            if period:
                term["start"] = period[0].isoformat()
                term["end"] = period[1].isoformat()
        return all_terms


def _vacation_blocks(dash: Dict[str, Any]) -> List[tuple]:
    """Каникулярные блоки (начало, конец) из дашборда."""
    blocks: List[tuple] = []
    for item in dash.get("vacations") or []:
        if not isinstance(item, dict):
            continue
        start = _as_date(item.get("startDate"))
        end = _as_date(item.get("endDate"))
        if start and end:
            blocks.append((start, end))
    blocks.sort(key=lambda pair: pair[1])
    return blocks


def _nearest_vacation_end(blocks: List[tuple], ideal: date, lo: date, hi: date) -> date:
    """Ближайший к «идеальной» границе конец каникулярного блока."""
    best: Optional[date] = None
    best_delta: Optional[int] = None
    for _, end in blocks:
        if end < lo or end > hi:
            continue
        delta = abs((end - ideal).days)
        if best_delta is None or delta < best_delta:
            best, best_delta = end, delta
    return best or ideal


def term_period_ranges(state: AppState) -> Dict[str, tuple]:
    """Границы (начало, конец) учебных периодов по их id.

    Почему это нужно: в отчёте StudentTotal СГО меняет заголовок
    «Учебный период» по фильтру TERMID, но сами данные всегда режет по
    фильтру «period» — интервалу дат. Поэтому при смене триместра без
    явных дат приходили те же самые оценки текущего периода.

    Точные даты есть только у текущего периода (дашборд). Границы прошлых
    восстанавливаем так:
    - учебный год начинается 1 сентября;
    - конец периода = начало следующего − 1 день;
    - внутренние границы ставим по каникулам: берём конец каникулярного
      блока, ближайший к середине промежутка.
    """
    def producer() -> Dict[str, tuple]:
        with state.lock:
            state.connect()
            dash = dashboard_data(state)
            current_id = str(dash.get("termId") or "")
            cur_start = _as_date(dash.get("termStartDate"))
            cur_end = _as_date(dash.get("termEndDate"))
            terms = _term_list(state)
            if not terms or not cur_start:
                return {}

            ids = [t["id"] for t in terms]
            if current_id in ids:
                idx = ids.index(current_id)
            else:
                idx = len(ids) - 1

            ranges: Dict[str, tuple] = {}
            if current_id:
                ranges[current_id] = (cur_start, cur_end or cur_start)

            past = ids[:idx]
            if past:
                # Учебный год начинается 1 сентября.
                year = cur_start.year if cur_start.month >= 9 else cur_start.year - 1
                span_start = date(year, 9, 1)
                span_end = cur_start - timedelta(days=1)
                blocks = _vacation_blocks(dash)
                count = len(past)
                if count == 1:
                    ranges[past[0]] = (span_start, span_end)
                else:
                    days = (span_end - span_start).days + 1
                    boundaries: List[date] = []
                    for k in range(1, count):
                        ideal = span_start + timedelta(days=round(days * k / count))
                        boundaries.append(_nearest_vacation_end(blocks, ideal, span_start, span_end))
                    prev_start = span_start
                    for i, term_id in enumerate(past):
                        end = boundaries[i] if i < len(boundaries) else span_end
                        if end < prev_start:
                            end = prev_start
                        ranges[term_id] = (prev_start, end)
                        prev_start = end + timedelta(days=1)
            return ranges

    return state.cached("term_period_ranges", 1800, producer)


def _period_filter_value(period: Optional[tuple]) -> str:
    """Значение фильтра «period» для СГО в формате отчёта."""
    if not period:
        return ""
    start, end = period
    return "%sT00:00:00.0000000 - %sT00:00:00.0000000" % (start.isoformat(), end.isoformat())


def _term_overrides(state: AppState, term_id: Optional[str]) -> Dict[str, str]:
    """Фильтры отчёта для выбранного периода: TERMID + интервал дат."""
    if not term_id:
        return {}
    overrides = {"TERMID": str(term_id)}
    try:
        period = term_period_ranges(state).get(str(term_id))
    except Exception:
        period = None
    value = _period_filter_value(period)
    if value:
        overrides["period"] = value
    return overrides


def _subject_key(name: Any) -> str:
    """Нормализованное имя предмета для сопоставления отчёта и дневника."""
    text = re.sub(r"\s+", " ", str(name or "").casefold().replace("ё", "е")).strip()
    return text


def _mark_value(value: Any) -> str:
    """'5', 5, 5.0, '5,0' -> '5' (единый вид для сопоставления)."""
    try:
        number = float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return str(value).strip()
    return str(int(number)) if number == int(number) else f"{number:g}"


def _is_debt(value: Any) -> bool:
    """Долг — это точка или прочерк в журнале."""
    return str("" if value is None else value).strip() in (".", "-")


def _mark_number(value: Any) -> Optional[float]:
    """Числовое значение отметки для расчётов.

    Долг («.»/«-») по просьбе пользователя считается как «2» — так же,
    как в веб-интерфейсе (js/weights.js). Вес при этом учитывается.
    """
    text = str("" if value is None else value).strip()
    if text in (".", "-"):
        return 2.0
    try:
        number = float(text.replace(",", "."))
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _weighted_average(marks: List[Dict[str, Any]]) -> Optional[float]:
    """Взвешенное среднее по отметкам: Σ(значение × вес) / Σ(вес)."""
    total = 0.0
    weights = 0.0
    for mark in marks or []:
        value = _mark_number(mark.get("value"))
        if value is None:
            continue
        weight = mark.get("weight") or 1
        total += value * weight
        weights += weight
    return round(total / weights, 2) if weights else None


def _term_range(parsed: Dict[str, Any], dashboard: Dict[str, Any]) -> tuple:
    days = [_as_date(day) for day in parsed.get("days") or []]
    days = [day for day in days if day]
    if days:
        return min(days), max(days)
    start = _as_date(dashboard.get("termStartDate"))
    end = _as_date(dashboard.get("termEndDate")) or date.today()
    return start, end


def _weights_index(state: AppState, start: Optional[date], end: Optional[date]) -> Dict[tuple, List[Dict[str, Any]]]:
    """Индекс (предмет, дата, оценка) -> [вес, id задания, тип] из дневника.

    Веса в отчёте StudentTotal отсутствуют, поэтому берём их из student/diary.
    СГО отдаёт весь учебный период одним запросом.
    """
    if not start or not end or end < start:
        return {}
    cache_key = f"weights:{start.isoformat()}:{end.isoformat()}"

    def producer() -> Dict[tuple, List[Dict[str, Any]]]:
        diary = state.client.diary_range(start, end)
        index: Dict[tuple, List[Dict[str, Any]]] = {}
        for day in diary.get("weekDays") or []:
            day_date = _as_date(day.get("date"))
            if not day_date:
                continue
            iso = day_date.isoformat()
            for lesson in day.get("lessons") or []:
                subject = _subject_key(lesson.get("subjectName"))
                for assignment in lesson.get("assignments") or []:
                    raw_mark = assignment.get("mark")
                    value = raw_mark.get("mark") if isinstance(raw_mark, dict) else raw_mark
                    if value in (None, "", 0):
                        continue
                    key = (subject, iso, _mark_value(value))
                    index.setdefault(key, []).append({
                        "weight": assignment.get("weight") or 1,
                        "id": assignment.get("id") or (raw_mark.get("assignmentId") if isinstance(raw_mark, dict) else None),
                        "typeId": assignment.get("typeId"),
                    })
        return index

    cached = state.cached(cache_key, 900, producer)
    # cached() возвращает один и тот же объект, а _take_mark_info делает pop().
    # Без копии второй запрос за те же 15 минут получил бы пустые списки и все
    # оценки снова стали бы весом 1.
    return {key: [dict(entry) for entry in bucket] for key, bucket in cached.items()}


def _take_mark_info(index: Dict[tuple, List[Dict[str, Any]]], subject: str,
                    mark_date: str, value: str) -> Optional[Dict[str, Any]]:
    """Достаёт вес оценки; для «Английский язык/Иностранный» пробует и короткое имя."""
    subject_key = _subject_key(subject)
    keys = [subject_key]
    head = subject_key.split("/")[0].strip()
    if head and head != subject_key:
        keys.append(head)
    for key in keys:
        bucket = index.get((key, mark_date, value))
        if bucket:
            return bucket.pop()
    # Мягкий вариант: отчёт и дневник по-разному уточняют название предмета.
    for (index_subject, day, mark), bucket in index.items():
        if bucket and day == mark_date and mark == value and (
            index_subject in subject_key or subject_key in index_subject
        ):
            return bucket.pop()
    return None


def _grades_cache_path() -> Path:
    """Файл с последними удачными данными успеваемости."""
    return core.config_dir() / "sgo_grades_lastgood.json"


def _load_last_good_grades(term_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """Последние удачные данные успеваемости с диска (после перезапуска тоже)."""
    try:
        data = json.loads(_grades_cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    item = data.get(str(term_id or "current"))
    return item if isinstance(item, dict) else None


def _save_last_good_grades(term_id: Optional[str], payload: Dict[str, Any]) -> None:
    """Сохраняет удачные данные успеваемости на диск."""
    path = _grades_cache_path()
    try:
        data: Dict[str, Any] = {}
        if path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data = loaded
            except (OSError, ValueError):
                data = {}
        data[str(term_id or "current")] = payload
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except (OSError, ValueError):
        pass


def grades_data(state: AppState, term_id: str = None) -> Dict[str, Any]:
    with state.lock:
        state.connect()
        dash = dashboard_data(state)
        current_term_id = str(dash.get("termId") or "")

        overrides = _term_overrides(state, term_id)
        report_key = f"report:studenttotal:{term_id or 'current'}"
        try:
            def producer():
                html = state.reports.generate_html("StudentTotal", overrides)
                return parse_student_total(html)
            # СГО ограничивает число запросов отчётов одним пользователем.
            # Если предыдущий запрос недавно упал — не повторяем его сразу,
            # а ждём и показываем последние удачные данные.
            recent = state.recent_report_failure(report_key)
            if recent:
                raise ReportError(recent)
            try:
                parsed = state.cached(report_key, 600, producer)
            except Exception as exc:
                state.note_report_failure(report_key, str(exc))
                raise

            # Веса оценок: без них калькулятор считает все оценки как x1.
            try:
                start, end = _term_range(parsed, dash)
                weights = _weights_index(state, start, end)
            except Exception as exc:
                traceback.print_exc()
                print(f"! Не удалось получить веса оценок: {exc}", file=sys.stderr)
                weights = {}

            subjects = []
            all_values = []
            weighted_sum = 0.0
            weight_total = 0.0
            counts = {str(i): 0 for i in range(1, 6)}
            debts_count = 0
            absences = []
            absent_counts = {}
            for item in parsed.get("subjects") or []:
                subject_name = item.get("name") or ""
                raw_marks = sorted(item.get("marks") or [], key=lambda m: m["date"], reverse=True)
                marks = []
                subject_sum = 0.0
                subject_weight = 0.0
                for m in raw_marks:
                    value = m.get("value")
                    mark_date = str(m.get("date") or "")[:10]
                    info = _take_mark_info(weights, subject_name, mark_date, _mark_value(value)) or {}
                    weight = info.get("weight") or 1
                    type_id = info.get("typeId")
                    type_name = ""
                    if type_id is not None:
                        try:
                            type_name = state.client._assignment_types.get(int(type_id), "")
                        except (TypeError, ValueError, AttributeError):
                            type_name = ""
                    marks.append({
                        "id": info.get("id"),
                        "value": value,
                        "date": m.get("date"),
                        "weight": weight,
                        "type": type_name,
                        "topic": "",
                    })
                    # Долг («.»/«-») считаем как «2» — так же, как в интерфейсе.
                    v = _mark_number(value)
                    if v is None:
                        continue
                    if _is_debt(value):
                        debts_count += 1
                    else:
                        key = str(int(v)) if v == int(v) else str(v)
                        counts[key] = counts.get(key, 0) + 1
                    all_values.append(v)
                    weighted_sum += v * weight
                    weight_total += weight
                    subject_sum += v * weight
                    subject_weight += weight
                subjects.append({
                    "name": subject_name,
                    "marks": marks,
                    # «average» — среднее из отчёта СГО, его не трогаем.
                    "average": float(item.get("average")) if item.get("average") else None,
                    # Собственное взвешенное среднее (долг = 2, вес задания учитывается).
                    "weightedAverage": round(subject_sum / subject_weight, 2) if subject_weight else None,
                    "weight": subject_weight,
                })
                for absence in item.get("absences") or []:
                    code = (absence.get("code") or "").upper()
                    absences.append({"date": absence.get("date"), "code": code, "label": ATTENDANCE_CODES.get(code, code), "subject": subject_name, "counted": code not in NOT_ABSENCE_CODES})
                    if code not in NOT_ABSENCE_CODES: absent_counts[code] = absent_counts.get(code, 0) + 1
            payload = {
                "subjects": subjects,
                "average": round(weighted_sum / weight_total, 2) if weight_total else None,
                "marksCount": len(all_values), "counts": counts, "debtsCount": debts_count,
                "attendance": {"items": absences, "counts": absent_counts, "total": sum(absent_counts.values()),
                               # Пустой список = «пропусков нет» только если отчёт реально разобран.
                               "available": bool(parsed.get("subjects"))},
                "asOf": parsed.get("as_of") or "", "term": parsed.get("term") or dash.get("termName") or "",
            }
            # Даты выбранного периода — чтобы в интерфейсе было видно,
            # за какой именно отрезок времени пришли данные.
            try:
                period = term_period_ranges(state).get(str(term_id or "")) if term_id else None
            except Exception:
                period = None
            if period:
                payload["termStart"] = period[0].isoformat()
                payload["termEnd"] = period[1].isoformat()
            # Запоминаем, чтобы при лимите запросов у СГО показать эти данные,
            # а не пустые списки.
            state.remember(f"grades:lastgood:{term_id or 'current'}", payload)
            _save_last_good_grades(term_id, payload)
            return payload
        except Exception as e:
            traceback.print_exc()
            print(f"! grades_data({term_id=}) failed: {e}", file=sys.stderr)
            # Та же защита, что в results_by_term_data: для не текущего периода
            # не подставляем дашборд (он всегда про текущий триместр).
            is_future = bool(term_id and current_term_id and term_id != current_term_id)
            if not is_future:
                # Показываем последние удачные данные, а не пустые списки:
                # СГО мог отклонить запрос отчёта (лимит на число запросов).
                last = state.last_good(f"grades:lastgood:{term_id or 'current'}")
                if last is None:
                    last = _load_last_good_grades(term_id)
                if last:
                    data = dict(last)
                    data["error"] = (
                        f"Показаны последние полученные данные: {e}. "
                        "Обновите их позже — СГО временно ограничивает число запросов."
                    )
                    data["stale"] = True
                    return data
            return {
                "subjects": [], "average": None, "marksCount": 0, "counts": {},
                "attendance": {"items": [], "counts": {}, "total": 0, "available": False},
                "asOf": "", "term": "" if is_future else (dash.get("termName") or ""),
                "error": (
                    f"Оценки за выбранный период недоступны. "
                    f"Скорее всего, этот триместр ещё не начался. ({e})"
                ) if is_future else f"Не удалось получить оценки за выбранный период: {e}",
                "requestedTermId": term_id,
            }

def assignment_details(state: AppState, assignment_id: int) -> Dict[str, Any]:
    # Кэш подробностей: клик по оценке не должен каждый раз ходить в СГО.
    with _details_cache_lock:
        entry = _details_cache.get(assignment_id)
        if entry and (time.time() - entry[0]) < DETAILS_CACHE_TTL:
            return entry[1]

    with state.lock:
        state.connect()
        info = state.client.assignment_info(assignment_id)

    def _clean(value: Any) -> str:
        """Убирает пустые значения и строку «null» — иначе в UI висит «null»."""
        if not isinstance(value, str):
            return ""
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value)).strip()
        if not text or text.lower() in ("null", "none"):
            return ""
        return text

    details = []
    for key in ("description", "problemName", "activityName", "comment"):
        text = _clean(info.get(key))
        if text and text not in details:
            details.append(text)
    teachers = [_clean(t.get("name")) for t in (info.get("teachers") or []) if isinstance(t, dict)]
    teachers = [t for t in teachers if t]
    files = []
    for f in (info.get("attachments") or []):
        if not isinstance(f, dict):
            continue
        name = _clean(f.get("name") or f.get("originalFileName"))
        if name:
            files.append(name)

    # Предмет из группы («9г/Алгебра»).
    subject = ""
    group = info.get("subjectGroup")
    if isinstance(group, dict):
        subject = _clean(group.get("name"))

    # Дата урока: СГО отдаёт «2026-11-12T00:00:00».
    date_text = ""
    raw_date = info.get("date")
    if isinstance(raw_date, str) and len(raw_date) >= 10:
        date_text = raw_date[:10]

    weight = info.get("weight")
    try:
        weight = int(weight) if weight is not None else 0
    except (TypeError, ValueError):
        weight = 0

    average = info.get("averageMark")
    try:
        average = float(average) if average is not None else None
    except (TypeError, ValueError):
        average = None

    # Оценки класса по этому заданию: сколько людей получило каждую отметку.
    class_marks = []
    for stat in info.get("markStats") or []:
        if not isinstance(stat, dict):
            continue
        value = stat.get("mark")
        count = stat.get("count")
        if value is None or count is None:
            continue
        try:
            class_marks.append({
                "mark": str(value),
                "count": int(count),
                "percentage": int(stat.get("percentage") or 0),
            })
        except (TypeError, ValueError):
            continue

    payload = {
        "id": assignment_id,
        "subject": subject,
        "topic": _clean(info.get("assignmentName")),
        "date": date_text,
        "weight": weight,
        "averageMark": average,
        "markStats": class_marks,
        "details": details,
        "teachers": teachers,
        "files": files,
    }

    with _details_cache_lock:
        _details_cache[assignment_id] = (time.time(), payload)
    return payload


def clear_details_cache() -> None:
    """Сбрасывает кэш подробностей заданий."""
    with _details_cache_lock:
        _details_cache.clear()


# --- Картинка главного экрана ---
HOME_IMAGE_MAX_BYTES = 12 * 1024 * 1024


def _home_image_file() -> Path:
    return core.config_dir() / "home_image.bin"


def _home_image_mime_file() -> Path:
    return core.config_dir() / "home_image.mime"


def home_image_info() -> Dict[str, Any]:
    """Сведения о сохранённой картинке главного экрана."""
    path = _home_image_file()
    if not path.is_file():
        return {"has": False, "mime": "", "updated": "", "size": 0}
    try:
        stat = path.stat()
        updated = datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")
        size = stat.st_size
    except OSError:
        return {"has": False, "mime": "", "updated": "", "size": 0}
    mime = "image/jpeg"
    try:
        mime = _home_image_mime_file().read_text(encoding="utf-8").strip() or mime
    except OSError:
        pass
    return {"has": True, "mime": mime, "updated": updated, "size": size}


def save_home_image(data_url: str) -> Dict[str, Any]:
    """Сохраняет картинку, пришедшую как data URL."""
    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", str(data_url or "").strip(), re.S)
    if not match:
        raise ValueError("Не удалось распознать изображение")
    mime = match.group(1).lower()
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", match.group(2)))
    except Exception:
        raise ValueError("Не удалось распознать изображение")
    if not raw:
        raise ValueError("Файл пустой")
    if len(raw) > HOME_IMAGE_MAX_BYTES:
        raise ValueError("Файл слишком большой (максимум 12 МБ)")

    path = _home_image_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(raw)
    os.replace(tmp, path)
    try:
        _home_image_mime_file().write_text(mime, encoding="utf-8")
    except OSError:
        pass
    return home_image_info()


def delete_home_image() -> Dict[str, Any]:
    """Удаляет сохранённую картинку."""
    for path in (_home_image_file(), _home_image_mime_file()):
        try:
            if path.exists():
                path.unlink()
        except OSError:
            pass
    return home_image_info()


def about_data(state: AppState) -> Dict[str, Any]:
    """Сведения о сборке и путях — для служебного режима в настройках."""
    try:
        data_dir = str(core.config_dir())
    except Exception:
        data_dir = ""
    return {
        "version": APP_VERSION,
        "build": APP_BUILD,
        "platform": sys.platform,
        "python": platform.python_version(),
        "dataDir": data_dir,
        # ID школы — не пароль: он и так виден в настройках СГО.
        "school": str(state.config.get("school_id") or state.config.get("school") or ""),
    }


def preload_assignments(state: AppState, ids: List[int]) -> int:
    """Заранее загружает подробности заданий в фоне.

    Ответ клиенту уходит сразу, а сами подробности кладутся в кэш:
    к моменту клика по оценке они уже готовы.
    """
    wanted = []
    for raw in ids:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if value > 0 and value not in wanted:
            wanted.append(value)
    if not wanted:
        return 0

    def worker() -> None:
        for assignment_id in wanted:
            try:
                assignment_details(state, assignment_id)
            except Exception as exc:
                print(f"! предзагрузка подробностей ({assignment_id}) не удалась: {exc}", file=sys.stderr)

    threading.Thread(target=worker, name="sgo-details-preload", daemon=True).start()
    return len(wanted)

class SgoHttpServer(ThreadingHTTPServer):
    """HTTP-сервер с защитой от «двойного» захвата порта в Windows.

    socketserver по умолчанию включает SO_REUSEADDR, а на Windows он позволяет
    ВТОРОМУ процессу занять уже прослушиваемый порт. В итоге запросы попадают
    то в старый процесс, то в новый — выглядит как «PyInstaller закешировал код».
    """

    allow_reuse_address = False
    daemon_threads = True


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "SgoDiary/2.0"
    state: AppState

    MAX_BODY = 1 * 1024 * 1024

    def log_message(self, fmt: str, *args: Any) -> None:
        try:
            stream = sys.stdout or sys.stderr
            if stream is None:
                return
            stream.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))
            stream.flush()
        except Exception:
            pass

    def _send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status); self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)

    def _send_json(self, payload: Any, status: int = 200) -> None:
        self._send_bytes(json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def _error(self, message: str, status: int = 500) -> None:
        self._send_json({"ok": False, "error": message}, status)

    def do_GET(self) -> None:
        parsed = urlparse(self.path); path = parsed.path; query = parse_qs(parsed.query)
        try:
            if path == "/api/check_auth":
                with self.state.lock:
                    if self.state.client is None and self.state.config.get("login") and self.state.config.get("password"):
                        try:
                            self.state.connect()
                        except Exception as exc:
                            self.log_message("auto-login failed: %s", exc)
                self._send_json({"ok": True, "authenticated": self.state.client is not None,
                                 "school": str(self.state.config.get("school_id") or "")})
            elif path == "/api/quick": self._handle_quick(query)
            elif path == "/api/grades":
                term_id = (query.get("term") or [None])[0]
                self._handle_grades(term_id)
            elif path == "/api/results":
                term_id = (query.get("term") or [None])[0]
                mode = (query.get("mode") or ["current"])[0]
                try:
                    data = results_by_term_data(self.state, term_id, "year" if mode == "year" else "current")
                except (ReportError, core.SgoError) as exc:
                    self._send_json({"ok": False, "error": f"Не удалось получить итоги: {exc}"}, 502)
                    return
                self._send_json({"ok": True, "updated": datetime.now().isoformat(timespec="seconds"), **data})
            elif path == "/api/diary":
                week = (query.get("week") or [None])[0]
                raw_refresh = (query.get("refresh") or ["0"])[0]
                force = str(raw_refresh).strip().lower() in ("1", "true", "yes")
                self._send_json({"ok": True, **diary_data(self.state, week, force=force)})
            elif path == "/api/diary/preload":
                # Фоновая предзагрузка соседних недель — отдаём сразу.
                raw = (query.get("weeks") or ["2"])[0]
                try:
                    weeks = max(1, min(4, int(raw)))
                except (TypeError, ValueError):
                    weeks = 2
                self._send_json({"ok": True, "started": start_diary_preload(self.state, weeks)})
            elif path == "/api/schedule":
                week = (query.get("week") or [None])[0]
                self._send_json({"ok": True, **schedule_data(self.state, week)})
            elif path == "/api/terms":
                self._send_json({"ok": True, "terms": terms_data(self.state)})
            elif path == "/api/about":
                self._send_json({"ok": True, **about_data(self.state)})
            elif path == "/api/home-image/info":
                self._send_json({"ok": True, **home_image_info()})
            elif path == "/api/home-image":
                info = home_image_info()
                if not info.get("has"):
                    self._error("Картинка не найдена", 404); return
                try:
                    data = _home_image_file().read_bytes()
                except OSError:
                    self._error("Картинка не найдена", 404); return
                self._send_bytes(data, str(info.get("mime") or "image/jpeg"))
            elif path == "/api/ping":
                self._send_json({"ok": True, "time": datetime.now().isoformat(timespec="seconds")})
            elif path == "/api/assignment/preload":
                # Заранее грузим подробности заданий — отвечаем сразу.
                raw_ids = (query.get("ids") or [""])[0]
                ids = [part for part in str(raw_ids).split(",") if part.strip()]
                count = preload_assignments(self.state, ids)
                self._send_json({"ok": True, "started": count > 0, "count": count})
            elif path.startswith("/api/assignment/"):
                raw_id = path.rsplit("/", 1)[-1]
                try: aid = int(raw_id)
                except ValueError: self._error("Некорректный id задания", 400); return
                try: self._send_json({"ok": True, **assignment_details(self.state, aid)})
                except Exception as exc: self._send_json({"ok": False, "error": str(exc)}, 502)
            elif path == "/api/refresh":
                self.state.reset()
                clear_diary_cache()
                self._send_json({"ok": True})
            else: self._serve_static(path)
        except Exception as exc:
            if "Не авторизован" in str(exc):
                self._send_json({"ok": False, "error": "Не авторизован"}, 401)
            else:
                traceback.print_exc(); self._error(str(exc))

    def do_HEAD(self) -> None: self.do_GET()

    def do_DELETE(self) -> None:
        path = self._normalize_path(self.path)
        self.log_message("DELETE %s", path)
        if path == "/api/home-image":
            self._send_json({"ok": True, **delete_home_image()})
            return
        self._error(f"Неизвестный запрос: DELETE {path}", 404)

    @staticmethod
    def _normalize_path(raw: str) -> str:
        path = urlparse(raw or "").path or "/"
        if len(path) > 1:
            path = path.rstrip("/")
        return path or "/"

    def _read_body(self) -> bytes:
        transfer = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in transfer:
            chunks: List[bytes] = []
            total = 0
            while True:
                line = self.rfile.readline(65536)
                if not line:
                    break
                try:
                    size = int(line.split(b";")[0].strip(), 16)
                except ValueError:
                    break
                if size == 0:
                    while True:
                        trailer = self.rfile.readline(65536)
                        if trailer in (b"\r\n", b"\n", b""):
                            break
                    break
                total += size
                if total > self.MAX_BODY:
                    raise ValueError("Слишком большой запрос")
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)
            return b"".join(chunks)

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0:
            return b""
        if length > self.MAX_BODY:
            raise ValueError("Слишком большой запрос")

        data = b""
        while len(data) < length:
            chunk = self.rfile.read(length - len(data))
            if not chunk:
                break
            data += chunk
        return data

    def _read_payload(self) -> Dict[str, Any]:
        raw = self._read_body()
        if not raw:
            return {}

        text = None
        for encoding in ("utf-8-sig", "utf-8", "cp1251"):
            try:
                text = raw.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        if text is None:
            raise ValueError("Не удалось прочитать тело запроса (кодировка)")

        text = text.strip()
        if not text:
            return {}

        content_type = (self.headers.get("Content-Type") or "").lower()
        if "application/x-www-form-urlencoded" in content_type and not text.startswith(("{", "[")):
            return {key: values[0] for key, values in parse_qs(text, keep_blank_values=True).items()}

        try:
            data = json.loads(text)
        except ValueError:
            if "=" in text:
                return {key: values[0] for key, values in parse_qs(text, keep_blank_values=True).items()}
            raise ValueError("Тело запроса не является корректным JSON")
        return data if isinstance(data, dict) else {}

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:
        try:
            self._dispatch_post()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            traceback.print_exc()
            try:
                self._error(str(exc), 500)
            except Exception:
                pass

    def _dispatch_post(self) -> None:
        path = self._normalize_path(self.path)
        self.log_message("POST %s", path)

        if path in ("/api/login", "/api/auth/login"):
            self._handle_login()
            return
        if path == "/api/logout":
            self._handle_logout()
            return
        if path == "/api/refresh":
            self._handle_refresh()
            return
        if path == "/api/check_auth":
            self._send_json({"ok": True, "authenticated": self.state.client is not None,
                             "school": str(self.state.config.get("school_id") or "")})
            return
        if path == "/api/home-image":
            try:
                payload = self._read_payload()
            except ValueError as exc:
                self._send_json({"ok": False, "error": str(exc)}, 400)
                return
            try:
                info = save_home_image(str(payload.get("data") or ""))
            except ValueError as exc:
                self._send_json({"ok": False, "error": str(exc)}, 400)
                return
            self._send_json({"ok": True, **info})
            return

        self._read_body_silent()
        self._error(f"Неизвестный запрос: POST {path}", 404)

    def _read_body_silent(self) -> None:
        try:
            self._read_body()
        except Exception:
            pass

    def _handle_login(self) -> None:
        try:
            data = self._read_payload()
        except ValueError as exc:
            self._send_json({"ok": False, "error": str(exc)}, 400)
            return

        login = str(data.get("login") or data.get("user") or data.get("username") or "").strip()
        password = data.get("pass")
        if password is None:
            password = data.get("password")
        password = "" if password is None else str(password)
        school = str(
            data.get("school") or data.get("school_id") or data.get("scid") or ""
        ).strip()

        if not login or not password:
            self._send_json({"ok": False, "error": "Введите логин и пароль"}, 400)
            return

        url = str(self.state.config.get("url") or core.DEFAULT_URL)
        try:
            client = core.SgoClient(url)
            client.login(login, password, school)
        except Exception as exc:
            self.log_message("login failed for %s: %s", login, exc)
            self._send_json(
                {"ok": False, "error": str(exc) or "Ошибка входа",
                 "login": login, "passLen": len(password)},
                401,
            )
            return

        school_id = school
        credentials = getattr(client, "_credentials", None)
        if credentials and len(credentials) >= 3:
            school_id = str(credentials[2])

        config = {"url": url, "login": login, "password": password, "school_id": school_id}
        with self.state.lock:
            self.state.client = client
            self.state.reports = ReportService(client)
            self.state.config = config
            self.state._cache.clear()

        try:
            saved_to = core.save_config(config)
            self.log_message("config saved to %s", saved_to)
        except OSError as exc:
            self.log_message("config save failed: %s", exc)

        self._send_json({"ok": True, "student": client.student_name})

    def _handle_logout(self) -> None:
        with self.state.lock:
            self.state.reset()
            self.state.config = {}
        try:
            # Последние данные успеваемости — тоже учётная запись, удаляем.
            path = _grades_cache_path()
            if path.is_file():
                path.unlink()
        except OSError as exc:
            self.log_message("grades cache remove failed: %s", exc)
        try:
            removed = core.clear_config()
            if removed:
                self.log_message("config removed: %s", ", ".join(map(str, removed)))
        except Exception as exc:
            self.log_message("config remove failed: %s", exc)
        self._send_json({"ok": True})

    def _handle_refresh(self) -> None:
        self._read_body_silent()
        with self.state.lock:
            self.state.reset()
        reconnected = False
        if self.state.config.get("login") and self.state.config.get("password"):
            try:
                with self.state.lock:
                    self.state.connect()
                reconnected = True
            except Exception as exc:
                self.log_message("refresh reconnect failed: %s", exc)
        self._send_json({"ok": True, "authenticated": reconnected})

    def _handle_quick(self, query: Dict[str, List[str]]) -> None:
        target = None
        raw_date = (query.get("date") or [""])[0]
        if raw_date:
            try: target = date.fromisoformat(raw_date)
            except ValueError: raise ValueError("Дата в формате ГГГГ-ММ-ДД")
        dashboard = dashboard_data(self.state)
        info = student_info(self.state, dashboard)
        info["average"] = (dashboard.get("averageMarks") or {}).get("commonAverageMark")
        payload = {"ok": True, "student": info, "homework": homework_data(self.state, target), "results": results_data(dashboard), "updated": datetime.now().isoformat(timespec="seconds")}
        self._send_json(payload)

    def _handle_grades(self, term_id: str = None) -> None:
        try: data = grades_data(self.state, term_id)
        except (ReportError, core.SgoError) as exc:
            self._send_json({"ok": False, "error": f"Не удалось получить оценки: {exc}"}, 502); return
        payload = {"ok": True, "updated": datetime.now().isoformat(timespec="seconds")}
        payload.update(data); self._send_json(payload)

    def _serve_static(self, path: str) -> None:
        if path in ("", "/"): path = "/index.html"
        relative = Path(path.lstrip("/"))
        if ".." in relative.parts: self._error("Недопустимый путь", 400); return
        target = (WEB_ROOT / relative).resolve()
        try: target.relative_to(WEB_ROOT.resolve())
        except ValueError: self._error("Недопустимый путь", 400); return
        if not target.is_file(): self._error("Страница не найдена", 404); return
        content_type = MIME_TYPES.get(target.suffix.lower()) or mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self._send_bytes(target.read_bytes(), content_type)

def create_server(host: str = "127.0.0.1", port: int = 8080, state: Optional[AppState] = None) -> ThreadingHTTPServer:
    """Создаёт готовый к работе сервер (используется и launcher.py, и main())."""
    state = state if state is not None else AppState(core.load_config())
    handler = type("SgoApiHandler", (ApiHandler,), {"state": state})
    return SgoHttpServer((host, port), handler)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        try: sys.stdout.reconfigure(encoding="utf-8"); sys.stderr.reconfigure(encoding="utf-8")
        except: pass
    state = AppState(core.load_config())
    server = create_server("127.0.0.1", 8080, state)
    print("Сервер запущен на http://127.0.0.1:8080")
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    return 0

if __name__ == "__main__":
    sys.exit(main())