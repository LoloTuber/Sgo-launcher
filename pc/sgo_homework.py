# -*- coding: utf-8 -*-
"""Клиент API «Сетевой город» (только для веб-приложения)."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import requests
except ImportError:
    sys.exit("Не установлен модуль requests. Установите: py -m pip install requests")

DEFAULT_URL = "https://sgo.volganet.ru"
CONFIG_NAME = "sgo_config.json"


class SgoError(RuntimeError):
    """Понятная человеку ошибка."""
    pass


def _query_tokens(text: str, min_len: int = 3) -> List[str]:
    return [
        t for t in re.split(r"\s+", text.casefold().strip())
        if len(t) >= min_len or t.isdigit()
    ]


def _tokens_in_text(text: str, tokens: List[str]) -> bool:
    haystack = text.casefold()
    return all(re.search(rf"(?<!\w){re.escape(t)}(?!\w)", haystack) for t in tokens)


CONFIG_DIR_NAME = "SgoDiary"


def config_dir() -> Path:
    """Папка с настройками пользователя (%APPDATA%\\SgoDiary)."""
    app_data = os.getenv("APPDATA")
    if app_data:
        return Path(app_data) / CONFIG_DIR_NAME
    return Path.home() / f".{CONFIG_DIR_NAME.lower()}"


def config_path() -> Path:
    """Основной путь, куда сохраняется конфиг."""
    return config_dir() / CONFIG_NAME


def config_candidates() -> List[Path]:
    """Где искать конфиг: сначала AppData, затем рядом с программой."""
    raw = [
        config_path(),
        Path(__file__).with_name(CONFIG_NAME),
        Path.cwd() / CONFIG_NAME,
    ]
    unique: List[Path] = []
    for path in raw:
        try:
            resolved = path.resolve()
        except OSError:
            resolved = path
        if resolved not in unique:
            unique.append(resolved)
    return unique


def load_config() -> Dict[str, Any]:
    for path in config_candidates():
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError) as exc:
                print(f"! Не удалось прочитать {path}: {exc}", file=sys.stderr)
                continue
            if isinstance(data, dict):
                return data
    return {}


def save_config(config: Dict[str, Any]) -> Path:
    """Атомарно сохраняет конфиг в %APPDATA%\\SgoDiary\\sgo_config.json."""
    target = config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, target)  # на Windows replace атомарен поверх существующего файла
    return target


def clear_config() -> List[Path]:
    """Удаляет все найденные файлы конфига (выход из аккаунта)."""
    removed = []
    for path in config_candidates():
        try:
            if path.is_file():
                path.unlink()
                removed.append(path)
        except OSError as exc:
            print(f"! Не удалось удалить {path}: {exc}", file=sys.stderr)
    return removed

class SgoClient:
    def __init__(self, base_url: str = DEFAULT_URL, timeout: int = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Referer": self.base_url + "/",
            "Accept": "application/json, text/plain, */*",
        })
        self._credentials: Optional[Tuple[str, str, int]] = None
        self.student_id: Optional[int] = None
        self.year_id: Optional[int] = None
        self.student_name: str = ""
        self._assignment_types: Dict[int, str] = {}
        self._assignment_info: Dict[int, Dict[str, Any]] = {}

    def _url(self, path: str) -> str:
        return f"{self.base_url}/webapi/{path.lstrip('/')}"

    @staticmethod
    def _error_text(resp: "requests.Response") -> str:
        try:
            payload = resp.json()
            if isinstance(payload, dict) and payload.get("message"):
                return str(payload["message"])
        except ValueError:
            pass
        text = (resp.text or "").strip()
        return text[:300] if text else f"HTTP {resp.status_code}"

    def request(self, method: str, path: str, **kwargs: Any) -> "requests.Response":
        kwargs.setdefault("timeout", self.timeout)
        url = self._url(path)
        resp = self.session.request(method, url, **kwargs)
        
        if resp.status_code == 401 and self._credentials:
            self._do_login(*self._credentials)
            resp = self.session.request(method, url, **kwargs)
            
        if resp.status_code >= 400:
            raise SgoError(f"{path}: {self._error_text(resp)}")
        return resp

    def get(self, path: str, **kwargs: Any) -> Any:
        return self.request("GET", path, **kwargs).json()

    @staticmethod
    def _hash_password(password: str, salt: str) -> Tuple[str, str]:
        md5_password = hashlib.md5(password.encode("windows-1251")).hexdigest()
        pw2 = hashlib.md5((salt + md5_password).encode("utf-8")).hexdigest()
        return pw2[: len(password)], pw2

    def login(self, login: str, password: str, school: str) -> None:
        school_id = self.resolve_school(school) if school else self.detect_school(login)
        self._do_login(login, password, school_id)
        self._credentials = (login, password, school_id)
        self._load_context()

    def _do_login(self, login: str, password: str, school_id: int) -> None:
        self.session.get(self._url("logindata"), timeout=self.timeout)
        meta = self.session.post(self._url("auth/getdata"), timeout=self.timeout).json()
        salt = meta.pop("salt")
        pw, pw2 = self._hash_password(password, salt)

        data = {
            "loginType": 1,
            "scid": school_id,
            "un": login,
            "pw": pw,
            "pw2": pw2,
            **meta,
        }
        resp = self.session.post(self._url("login"), data=data, timeout=self.timeout)
        
        if resp.status_code >= 400:
            raise SgoError("Не удалось войти: " + self._error_text(resp) + "\nПроверьте логин, пароль и школу.")
            
        try:
            payload = resp.json()
        except ValueError:
            raise SgoError("Сервер вернул не JSON вместо токена. Возможно, изменился API.")
            
        token = payload.get("at")
        if not token:
            raise SgoError("Сервер не выдал токен: " + str(payload.get("message", payload)))
        self.session.headers["at"] = token

    def _load_context(self) -> None:
        info = self.get("student/diary/init")
        students = info.get("students") or []
        if not students:
            raise SgoError("В аккаунте не найдено ни одного ученика (дневник пуст?).")
            
        index = info.get("currentStudentId", 0)
        try:
            student = students[index]
        except (IndexError, TypeError):
            student = students[0]
            
        self.student_id = student.get("studentId") or student.get("id")
        self.student_name = (
            student.get("nickName")
            or student.get("fullName")
            or student.get("name")
            or ""
        )
        self.year_id = self._current_year_id()
        try:
            types = self.get("grade/assignment/types", params={"all": False})
            self._assignment_types = {
                int(item["id"]): str(item.get("name", ""))
                for item in types
                if isinstance(item, dict) and "id" in item
            }
        except SgoError:
            self._assignment_types = {}

    def _current_year_id(self) -> Optional[int]:
        attempts = ({}, {"studentId": self.student_id})
        for params in attempts:
            try:
                data = self.get("years/current", params=params)
                if isinstance(data, dict) and data.get("id") is not None:
                    return int(data["id"])
            except SgoError:
                continue
        return None

    def search_schools(self, query: str) -> List[Dict[str, Any]]:
        data = self.get("schools/search", params={"name": query})
        return data if isinstance(data, list) else []

    def search_schools_smart(self, query: str) -> List[Dict[str, Any]]:
        items = self.search_schools(query)
        if len(items) >= 3:
            return items

        tokens = _query_tokens(query)
        if not tokens:
            return items

        seen = {s.get("id") for s in items}
        for school in self.search_schools(max(tokens, key=len)):
            if school.get("id") in seen:
                continue
            text = f"{school.get('shortName', '')} {school.get('name', '')}"
            if _tokens_in_text(text, tokens):
                items.append(school)
                seen.add(school.get("id"))
        return items

    def resolve_school(self, school: str) -> int:
        school = str(school).strip()
        if school.isdigit():
            return int(school)

        found = self.search_schools_smart(school)
        key = school.casefold()

        def label(s: Dict[str, Any]) -> str:
            return str(s.get("shortName") or s.get("name") or "")

        exact = [s for s in found if label(s).casefold() == key or str(s.get("name", "")).casefold() == key]
        
        def token_match(s: Dict[str, Any]) -> bool:
            text = f"{label(s)} {s.get('name', '')}"
            return _tokens_in_text(text, _query_tokens(key, min_len=2))
            
        tokens = _query_tokens(key, min_len=2)
        candidates = exact or [s for s in found if label(s).casefold().startswith(key)] or [s for s in found if token_match(s)]

        plain = [s for s in candidates if "(" not in label(s)]
        if len(plain) == 1:
            return int(plain[0]["id"])
        if len(candidates) == 1:
            return int(candidates[0]["id"])
        if len(candidates) > 1:
            lines = [f"  {s['id']}: {label(s)}" for s in candidates[:20]]
            raise SgoError("Найдено несколько подходящих школ, укажите точное название или --school-id:\n" + "\n".join(lines))
            
        lines = [f"  {s['id']}: {label(s)}" for s in found[:20]]
        raise SgoError(f"Школа «{school}» не найдена. Возможные варианты:\n" + ("\n".join(lines) if lines else "  (ничего не найдено)") + "\nУточните название или укажите id через --school-id.")

    def detect_school(self, login: str) -> int:
        raise SgoError("Нужно указать школу.\nУточните название в sgo_config.json.")

    def diary(self, monday: date) -> Dict[str, Any]:
        return self.diary_range(monday, monday + timedelta(days=6))

    def diary_range(self, start: date, end: date) -> Dict[str, Any]:
        """Дневник за произвольный диапазон. СГО отдаёт весь период одним запросом."""
        if self.student_id is None:
            raise SgoError("Нет данных об ученике — сначала вызовите login().")
        params = {
            "studentId": self.student_id,
            "weekStart": start.isoformat(),
            "weekEnd": end.isoformat(),
        }
        if self.year_id is not None:
            params["yearId"] = self.year_id
        return self.get("student/diary", params=params)

    def assignment_info(self, assignment_id: int) -> Dict[str, Any]:
        try:
            key = int(assignment_id)
        except (TypeError, ValueError):
            return {}
        if key in self._assignment_info:
            return self._assignment_info[key]
            
        info: Dict[str, Any] = {}
        try:
            data = self.get(f"student/diary/assigns/{key}", params={"studentId": self.student_id})
            if isinstance(data, dict):
                info = data
        except (SgoError, ValueError):
            info = {}
            
        self._assignment_info[key] = info
        return info


# --------------------------------------------------------------------------- #
#  Парсинг и утилиты для веба
# --------------------------------------------------------------------------- #
def _as_date(value: Any) -> Optional[date]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)[:19]).date()
    except ValueError:
        return None


def lessons_for_day(diary: Dict[str, Any], target: date, assignment_types: Dict[int, str]) -> Optional[List[Dict[str, Any]]]:
    for day in diary.get("weekDays") or []:
        if not isinstance(day, dict):
            continue
        if _as_date(day.get("date")) != target:
            continue
            
        lessons = [l for l in (day.get("lessons") or []) if isinstance(l, dict)]
        for lesson in lessons:
            for assignment in lesson.get("assignments") or []:
                if isinstance(assignment, dict) and assignment.get("typeId") is not None:
                    try:
                        assessment_type = assignment_types.get(int(assignment["typeId"]))
                    except (TypeError, ValueError):
                        assessment_type = None
                    if assessment_type:
                        assignment["typeName"] = assessment_type
                        
        lessons.sort(key=lambda l: (l.get("number") or 0, l.get("startTime") or ""))
        return lessons
    return None


_TASK_KNOWN_KEYS = {
    "id", "assignId", "assignmentName", "typeId", "typeName", "mark",
    "markComment", "dutyMark", "dueDate", "attachments", "files", "weight",
    "subjectName", "color", "icon", "status",
}

_DETAIL_HINTS = ("comment", "detail", "descript", "note", "teacher", "task")
_UNUSED_DETAIL_KEYS = {"guid", "hash", "code", "uid"}
_TAG_RE = re.compile(r"<[^>]+>")

def _clean_text(text: str) -> str:
    text = re.sub(r"<\s*br\s*/?\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*(p|div|li)\s*>", "\n", text, flags=re.IGNORECASE)
    text = _TAG_RE.sub("", text)
    for entity, symbol in (
        ("&nbsp;", " "), ("&amp;", "&"), ("&quot;", '"'),
        ("&lt;", "<"), ("&gt;", ">"), ("&#39;", "'"),
    ):
        text = text.replace(entity, symbol)
    return text.strip()


def _extract_texts(value: Any, depth: int = 0) -> List[str]:
    if depth > 2 or value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, (int, float, bool)):
        return []
    if isinstance(value, dict):
        result: List[str] = []
        for nested in value.values():
            result.extend(_extract_texts(nested, depth + 1))
        return result
    if isinstance(value, (list, tuple)):
        result = []
        for nested in value:
            result.extend(_extract_texts(nested, depth + 1))
        return result
    return []


def _assignment_teacher(assignment: Dict[str, Any]) -> str:
    for key, value in assignment.items():
        lower = key.lower()
        if not any(word in lower for word in ("teacher", "prepod", "учител", "fio")):
            continue
        for raw in _extract_texts(value):
            text = _clean_text(raw)
            if text and not text.isdigit():
                return text
    return ""


def _assignment_details(assignment: Dict[str, Any]) -> List[str]:
    name = _clean_text(str(assignment.get("assignmentName") or ""))
    found: List[Tuple[int, str]] = []

    for key, value in assignment.items():
        lower = key.lower()
        if key in _TASK_KNOWN_KEYS or key in _UNUSED_DETAIL_KEYS:
            continue
        if any(word in lower for word in ("teacher", "prepod", "учител")):
            continue

        hinted = any(hint in lower for hint in _DETAIL_HINTS)
        for raw in _extract_texts(value):
            text = _clean_text(raw)
            if not text or text == name:
                continue
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}([T ].*)?", text) or text.isdigit():
                continue
            if not hinted and len(text) < 25:
                continue
            found.append((0 if hinted else 1, text))

    found.sort(key=lambda item: item[0])
    result: List[str] = []
    for _, text in found:
        if text not in result:
            result.append(text)
    return result


def _teachers_line(info: Dict[str, Any]) -> str:
    names = []
    for item in info.get("teachers") or []:
        if isinstance(item, dict):
            name = _clean_text(str(item.get("name") or ""))
            if name:
                names.append(name)
        elif isinstance(item, str) and item.strip():
            names.append(_clean_text(item))
    return ", ".join(names)


def _files_of(info: Dict[str, Any]) -> List[str]:
    names = []
    for item in info.get("attachments") or []:
        if isinstance(item, dict):
            name = str(item.get("name") or item.get("originalFileName") or "").strip()
            if name:
                names.append(name)
    return names


def collect(lessons: List[Dict[str, Any]], client: Optional["SgoClient"] = None) -> List[Dict[str, Any]]:
    """Собирает подробную информацию о заданиях (учитель, описание, файлы)."""
    out = []
    for lesson in lessons:
        tasks = []
        for a in lesson.get("assignments") or []:
            if not isinstance(a, dict):
                continue

            info: Dict[str, Any] = {}
            if client is not None and a.get("id"):
                info = client.assignment_info(a["id"])
            if not info.get("description") and a.get("description"):
                info = dict(info, description=a["description"])

            text = _clean_text(str(a.get("assignmentName") or ""))
            if _is_empty_task(text):
                text = ""

            try:
                type_id = int(a["typeId"]) if a.get("typeId") is not None else None
            except (TypeError, ValueError):
                type_id = None

            details: List[str] = []
            label = ""
            description = _clean_text(str(info.get("description") or ""))
            if description and description != text:
                label = "Подробности от учителя" if type_id == 3 else "Примечание"
                details.append(description)

            extra_texts = _assignment_details(a)
            for key in ("problemName", "activityName"):
                extra = _clean_text(str(info.get(key) or ""))
                if extra:
                    extra_texts.append(extra)
            for extra in extra_texts:
                if extra and extra != text and extra not in details:
                    details.append(extra)

            teacher = _assignment_teacher(a) or _teachers_line(info)
            files = _files_of(info)

            if not text and not details:
                continue

            tasks.append({
                "id": a.get("id"),
                "text": text,
                "type": a.get("typeName") or "",
                "type_id": type_id,
                "teacher": teacher,
                "details": details,
                "details_label": label,
                "files": files,
                "due": _as_date(a.get("dueDate")).isoformat() if _as_date(a.get("dueDate")) else None,
            })
            
        out.append({
            "number": lesson.get("number"),
            "subject": (lesson.get("subjectName") or "").strip(),
            "room": (lesson.get("room") or "").strip(),
            "start": (lesson.get("startTime") or "")[:5],
            "end": (lesson.get("endTime") or "")[:5],
            "tasks": tasks,
        })
    return out


_EMPTY_TASK = re.compile(r"^(без\s+домашн|нет\s+задани|не\s+задано)", re.IGNORECASE)


def _is_empty_task(text: str) -> bool:
    stripped = text.strip()
    if stripped in ("", "-", "—", "–"):
        return True
    return bool(_EMPTY_TASK.match(stripped))


def marks_for_weeks(client: "SgoClient", mondays: List[date]) -> List[Dict[str, Any]]:
    """Собирает оценки из дневника по неделям (с весами и темами)."""
    result: List[Dict[str, Any]] = []
    for monday in mondays:
        try:
            diary = client.diary(monday)
        except SgoError:
            continue
            
        for day in diary.get("weekDays") or []:
            if not isinstance(day, dict):
                continue
            day_date = _as_date(day.get("date"))
            
            for lesson in day.get("lessons") or []:
                if not isinstance(lesson, dict):
                    continue
                subject = (lesson.get("subjectName") or "").strip()
                
                for a in lesson.get("assignments") or []:
                    if not isinstance(a, dict):
                        continue
                    mark = a.get("mark")
                    
                    if isinstance(mark, dict):
                        value = mark.get("mark")
                        mark_date = _as_date(mark.get("date"))
                    else:
                        value = mark
                        mark_date = None
                        
                    if value is None:
                        continue
                    value_str = str(value).strip()
                    if not value_str:
                        continue

                    try:
                        type_id = int(a["typeId"]) if a.get("typeId") is not None else None
                    except (TypeError, ValueError):
                        type_id = None

                    result.append({
                        "id": a.get("id"),
                        "subject": subject,
                        "value": value_str,
                        "date": (mark_date or day_date or date.today()).isoformat(),
                        "topic": _clean_text(a.get("assignmentName") or ""),
                        "type_id": type_id,
                        "type_name": a.get("typeName") or "",
                        "weight": a.get("weight") or 1,
                    })
    return result