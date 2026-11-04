# -*- coding: utf-8 -*-
"""Локальный веб-интерфейс для дневника «Сетевой город»."""

import argparse
import json
import mimetypes
import os
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

_WEEKDAYS = ("понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье")
_MONTHS_GENITIVE = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")

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

    def cached(self, key: str, ttl: float, producer: Callable[[], Any]) -> Any:
        now = time.time()
        entry = self._cache.get(key)
        if entry and now - entry[0] < ttl: return entry[1]
        value = producer()
        self._cache[key] = (now, value)
        return value

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


def _results_from_parsed(parsed: Dict[str, Any], term_label: str, mode: str) -> Dict[str, Any]:
    """Собирает список «Итогов» из распарсенного отчёта StudentTotal.

    mode="year" — годовые отметки (последняя колонка таблицы);
    mode="current" — средние баллы за выбранный триместр/период.
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
        if final_value is not None:
            finals_present += 1
        value = final_value if mode == "year" else average_value
        subjects.append({
            "name": name,
            "average": value,
            "final": final_value,
            "termAverage": average_value,
            "marksCount": marks_count,
        })
        if value is not None:
            weight = marks_count if mode == "current" else 1
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
        overrides = {}
        if term_id:
            overrides["TERMID"] = term_id
        try:
            def producer():
                html = state.reports.generate_html("StudentTotal", overrides)
                return parse_student_total(html)
            parsed = state.cached(f"report:studenttotal:{term_id or 'current'}", 600, producer)
        except Exception as exc:
            # Не удалось получить отчёт — отдаём средние с дашборда (текущий период).
            data = results_data(dash)
            data["error"] = str(exc)
            return data
        label = dash.get("termName") or ""
        if term_id:
            try:
                for src in state.reports.info("StudentTotal").get("filterSources") or []:
                    if src.get("filterId") == "TERMID":
                        for item in src.get("items") or []:
                            if str(item.get("value")) == str(term_id):
                                label = str(item.get("title") or "")
            except Exception:
                pass
        return _results_from_parsed(parsed, label, "year" if mode == "year" else "current")

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

def diary_data(state: AppState, week_start: Optional[str] = None) -> Dict[str, Any]:
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
    return {"weekStart": monday.isoformat(), "weekEnd": (monday + timedelta(days=6)).isoformat(), "days": days}

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

def terms_data(state: AppState) -> List[Dict[str, str]]:
    with state.lock:
        state.connect()
        try:
            info = state.client.get("reports/StudentTotal")
            sources = info.get("filterSources") or []
            for src in sources:
                if src.get("filterId") == "TERMID":
                    items = src.get("items") or []
                    if items: return [{"id": str(i.get("value")), "name": str(i.get("title"))} for i in items if i.get("value")]
        except Exception: pass
        try:
            dash = dashboard_data(state)
            if dash.get("termId"): return [{"id": str(dash["termId"]), "name": dash.get("termName") or "Текущий период"}]
        except Exception: pass
        return []

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


def grades_data(state: AppState, term_id: str = None) -> Dict[str, Any]:
    with state.lock:
        state.connect()
        dash = dashboard_data(state)
        overrides = {}
        if term_id: overrides["TERMID"] = term_id
        try:
            def producer():
                html = state.reports.generate_html("StudentTotal", overrides)
                return parse_student_total(html)
            parsed = state.cached(f"report:studenttotal:{term_id or 'current'}", 600, producer)

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
            absences = []
            absent_counts = {}
            for item in parsed.get("subjects") or []:
                subject_name = item.get("name") or ""
                raw_marks = sorted(item.get("marks") or [], key=lambda m: m["date"], reverse=True)
                marks = []
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
                    try:
                        v = float(str(value).replace(",", "."))
                    except (TypeError, ValueError):
                        continue
                    all_values.append(v)
                    weighted_sum += v * weight
                    weight_total += weight
                    key = str(int(v)) if v == int(v) else str(v)
                    counts[key] = counts.get(key, 0) + 1
                subjects.append({
                    "name": subject_name,
                    "marks": marks,
                    "average": float(item.get("average")) if item.get("average") else None,
                })
                for absence in item.get("absences") or []:
                    code = (absence.get("code") or "").upper()
                    absences.append({"date": absence.get("date"), "code": code, "label": ATTENDANCE_CODES.get(code, code), "subject": subject_name, "counted": code not in NOT_ABSENCE_CODES})
                    if code not in NOT_ABSENCE_CODES: absent_counts[code] = absent_counts.get(code, 0) + 1
            return {
                "subjects": subjects,
                "average": round(weighted_sum / weight_total, 2) if weight_total else None,
                "marksCount": len(all_values), "counts": counts, "attendance": {"items": absences, "counts": absent_counts, "total": sum(absent_counts.values())},
                "asOf": parsed.get("as_of") or "", "term": parsed.get("term") or dash.get("termName") or "",
            }
        except Exception as e:
            return {"subjects": [], "average": None, "marksCount": 0, "counts": {}, "attendance": {"items": [], "counts": {}, "total": 0}, "asOf": "", "term": dash.get("termName") or "", "error": str(e)}

def assignment_details(state: AppState, assignment_id: int) -> Dict[str, Any]:
    with state.lock:
        state.connect()
        info = state.client.assignment_info(assignment_id)
    details = []
    for key in ("description", "problemName", "activityName", "comment"):
        val = info.get(key)
        if isinstance(val, str) and val.strip():
            text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", val)).strip()
            if text and text not in details: details.append(text)
    teachers = [t.get("name").strip() for t in (info.get("teachers") or []) if isinstance(t, dict) and t.get("name")]
    files = [str(f.get("name") or f.get("originalFileName") or "").strip() for f in (info.get("attachments") or []) if isinstance(f, dict)]
    return {"id": assignment_id, "details": details, "teachers": teachers, "files": [f for f in files if f]}

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

    # Ограничение на тело запроса: защита от мусора и «зависших» соединений.
    MAX_BODY = 1 * 1024 * 1024

    def log_message(self, fmt: str, *args: Any) -> None:
        # В сборке --windowed sys.stdout/sys.stderr могут быть None.
        # Без этой проверки падает КАЖДЫЙ ответ (send_response -> log_request).
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
                # После перезапуска клиента ещё нет: пробуем тихо войти по сохранённому конфигу.
                with self.state.lock:
                    if self.state.client is None and self.state.config.get("login") and self.state.config.get("password"):
                        try:
                            self.state.connect()
                        except Exception as exc:
                            self.log_message("auto-login failed: %s", exc)
                self._send_json({"ok": True, "authenticated": self.state.client is not None})
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
                self._send_json({"ok": True, **diary_data(self.state, week)})
            elif path == "/api/schedule":
                week = (query.get("week") or [None])[0]
                self._send_json({"ok": True, **schedule_data(self.state, week)})
            elif path == "/api/terms":
                self._send_json({"ok": True, "terms": terms_data(self.state)})
            elif path == "/api/ping":
                self._send_json({"ok": True, "time": datetime.now().isoformat(timespec="seconds")})
            elif path.startswith("/api/assignment/"):
                raw_id = path.rsplit("/", 1)[-1]
                try: aid = int(raw_id)
                except ValueError: self._error("Некорректный id задания", 400); return
                try: self._send_json({"ok": True, **assignment_details(self.state, aid)})
                except Exception as exc: self._send_json({"ok": False, "error": str(exc)}, 502)
            elif path == "/api/refresh":
                self.state.reset(); self._send_json({"ok": True})
            else: self._serve_static(path)
        except Exception as exc:
            if "Не авторизован" in str(exc):
                self._send_json({"ok": False, "error": "Не авторизован"}, 401)
            else:
                traceback.print_exc(); self._error(str(exc))

    def do_HEAD(self) -> None: self.do_GET()

    # --- POST: чтение тела и маршрутизация ---------------------------------

    @staticmethod
    def _normalize_path(raw: str) -> str:
        """'/api/login/', '/api/login?x=1' и абсолютный URL -> '/api/login'."""
        path = urlparse(raw or "").path or "/"
        if len(path) > 1:
            path = path.rstrip("/")
        return path or "/"

    def _read_body(self) -> bytes:
        """Читает тело запроса целиком: поддерживает Content-Length и chunked."""
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
                    while True:  # дочитываем трейлеры
                        trailer = self.rfile.readline(65536)
                        if trailer in (b"\r\n", b"\n", b""):
                            break
                    break
                total += size
                if total > self.MAX_BODY:
                    raise ValueError("Слишком большой запрос")
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)  # CRLF после чанка
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
        """Тело запроса -> dict. Понимает JSON и form-urlencoded, UTF-8 и cp1251."""
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
            if "=" in text:  # форма без корректного Content-Type
                return {key: values[0] for key, values in parse_qs(text, keep_blank_values=True).items()}
            raise ValueError("Тело запроса не является корректным JSON")
        return data if isinstance(data, dict) else {}

    def do_OPTIONS(self) -> None:
        """Preflight для режима разработки (страница на другом порту)."""
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
            pass  # окно закрыли / браузер оборвал соединение
        except Exception as exc:  # последняя линия обороны: всегда отвечаем JSON
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
            self._send_json({"ok": True, "authenticated": self.state.client is not None})
            return

        self._read_body_silent()  # дочитываем тело, иначе браузер получит reset
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
        password = "" if password is None else str(password)  # пароль НЕ trim'аем
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
            # Сообщение SgoError уже человекочитаемое («Не удалось войти: ...»).
            self.log_message("login failed for %s: %s", login, exc)
            self._send_json(
                {"ok": False, "error": str(exc) or "Ошибка входа",
                 "login": login, "passLen": len(password)},
                401,
            )
            return

        # Сохраняем уже разрешённый числовой id школы, чтобы автовход был быстрее.
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