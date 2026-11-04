# -*- coding: utf-8 -*-
"""Генерация отчётов «Сетевого города» через WebSocket-очередь."""

from __future__ import annotations

import base64
import json
import os
import re
import socket
import ssl
import struct
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

RECORD_SEPARATOR = "\x1e"
DATE_FORMAT = "d\x01mm\x01yy\x01."

class ReportError(RuntimeError):
    """Ошибка постановки или выполнения задачи генерации отчёта."""

class _WebSocket:
    def __init__(self, url: str, cookies: Dict[str, str], timeout: float = 60.0) -> None:
        parsed = urlparse(url)
        host = parsed.hostname or ""
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        raw = socket.create_connection((host, port), timeout=timeout)
        if parsed.scheme == "wss":
            context = ssl.create_default_context()
            self._sock = context.wrap_socket(raw, server_hostname=host)
        else:
            self._sock = raw
        self._sock.settimeout(timeout)

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        cookie_header = "; ".join(f"{k}={v}" for k, v in cookies.items())
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Origin: https://{host}\r\n"
            "User-Agent: Mozilla/5.0\r\n"
            f"Cookie: {cookie_header}\r\n"
            "\r\n"
        )
        self._sock.sendall(request.encode("ascii"))

        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise ReportError("Сервер закрыл соединение при подключении к очереди отчётов.")
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        status_line = head.split(b"\r\n")[0].decode("latin-1")
        if "101" not in status_line:
            raise ReportError(f"Не удалось подключиться к очереди отчётов: {status_line}")
        self._buffer = bytearray(rest)

    def _read_exact(self, size: int) -> bytes:
        while len(self._buffer) < size:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise ReportError("Соединение с очередью отчётов прервано.")
            self._buffer.extend(chunk)
        data = bytes(self._buffer[:size])
        del self._buffer[:size]
        return data

    def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        length = len(payload)
        header = bytearray([0x81])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self._sock.sendall(bytes(header) + masked)

    def receive_text(self) -> str:
        while True:
            first, second = self._read_exact(2)
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if second & 0x80 else None
            payload = self._read_exact(length)
            if mask:
                payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
            if opcode == 0x9:
                self.send_text(payload.decode("utf-8", "replace"))
                continue
            if opcode == 0x8:
                raise ReportError("Сервер закрыл очередь отчётов.")
            if opcode in (0x1, 0x2):
                return payload.decode("utf-8", "replace")

    def close(self) -> None:
        try:
            self._sock.close()
        except OSError:
            pass

class ReportService:
    def __init__(self, client: Any) -> None:
        self.client = client
        self._context: Optional[Dict[str, Any]] = None
        self._info_cache: Dict[str, Dict[str, Any]] = {}

    @property
    def context(self) -> Dict[str, Any]:
        if self._context is None:
            self._context = self.client.get("context")
        return self._context

    def info(self, report_id: str) -> Dict[str, Any]:
        if report_id not in self._info_cache:
            self._info_cache[report_id] = self.client.get(f"reports/{report_id}")
        return self._info_cache[report_id]

    def selected_data(self, report_id: str, overrides: Optional[Dict[str, str]] = None) -> List[Dict[str, str]]:
        overrides = overrides or {}
        selected: List[Dict[str, str]] = []
        for source in self.info(report_id).get("filterSources") or []:
            filter_id = source.get("filterId")
            if not filter_id: continue
            value = overrides.get(filter_id, source.get("defaultValue"))
            if value is None: continue
            text = ""
            for item in source.get("items") or []:
                if str(item.get("value")) == str(value):
                    text = str(item.get("title") or "")
                    break
            selected.append({"filterId": str(filter_id), "filterValue": str(value), "filterText": text})
        for filter_id, value in overrides.items():
            if not any(item["filterId"] == filter_id for item in selected):
                selected.append({"filterId": filter_id, "filterValue": str(value), "filterText": ""})
        return selected

    def params(self, overrides: Optional[Dict[str, Any]] = None) -> List[Dict[str, str]]:
        result: List[Dict[str, str]] = []
        if self.client.year_id is not None:
            result.append({"name": "SCHOOLYEARID", "value": str(self.client.year_id)})
        result.append({"name": "SERVERTIMEZONE"})
        result.append({"name": "FULLSCHOOLNAME", "value": str(self.context.get("organizationName") or "")})
        result.append({"name": "DATEFORMAT", "value": DATE_FORMAT})
        for name, value in (overrides or {}).items():
            result = [item for item in result if item["name"] != name]
            entry: Dict[str, str] = {"name": name}
            if value is not None:
                entry["value"] = str(value)
            result.append(entry)
        return result

    def generate_html(self, report_id: str, overrides: Optional[Dict[str, str]] = None, timeout: float = 120.0) -> str:
        task = self.client.request(
            "POST", f"reports/{report_id}/queue",
            json={"selectedData": self.selected_data(report_id, overrides), "params": self.params()},
        ).json()
        task_id = task.get("taskId")
        if task_id is None:
            raise ReportError("Сервер не вернул идентификатор задачи отчёта.")

        file_id = self._wait_for_file(task_id, task.get("queueKey") or "report-v2", timeout)
        response = self.client.request("GET", f"files/{file_id}", timeout=60)
        return _decode_html(response.content)

    def _wait_for_file(self, task_id: int, queue_key: str, timeout: float) -> str:
        token = self.client.session.headers.get("at")
        if not token:
            raise ReportError("Нет токена авторизации для очереди отчётов.")
        base_host = urlparse(self.client.base_url).hostname
        url = f"wss://{base_host}/webapi/signalr/queueHub?at={token}"
        ws = _WebSocket(url, self.client.session.cookies.get_dict(), timeout=timeout)
        try:
            ws.send_text(json.dumps({"protocol": "json", "version": 1}) + RECORD_SEPARATOR)
            ws.receive_text()
            ws.send_text(json.dumps({"type": 1, "invocationId": "1", "target": "startTaskAsync", "arguments": [task_id, queue_key]}) + RECORD_SEPARATOR)

            while True:
                message = ws.receive_text()
                for part in message.split(RECORD_SEPARATOR):
                    if not part.strip(): continue
                    try:
                        payload = json.loads(part)
                    except ValueError:
                        continue
                    target = payload.get("target")
                    if target == "complete":
                        for argument in payload.get("arguments") or []:
                            if isinstance(argument, dict) and argument.get("data"):
                                return str(argument["data"])
                        raise ReportError("Отчёт сформирован, но сервер не вернул файл.")
                    if target == "error":
                        details = ""
                        for argument in payload.get("arguments") or []:
                            if isinstance(argument, dict):
                                details = str(argument.get("details") or argument.get("message") or "")
                        raise ReportError(details or "Генератор отчётов вернул ошибку.")
        finally:
            ws.close()

def _decode_html(raw: bytes) -> str:
    for encoding in ("utf-8", "cp1251"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")

_MONTHS = {
    "январь": 1, "февраль": 2, "март": 3, "апрель": 4, "май": 5, "июнь": 6,
    "июль": 7, "август": 8, "сентябрь": 9, "октябрь": 10, "ноябрь": 11, "декабрь": 12,
}

ATTENDANCE_CODES = {
    "Н": "не был",
    "НП": "пропуск по неуважительной причине",
    "УП": "пропуск по уважительной причине",
    "Б": "пропустил по болезни",
    "ОТ": "отсутствовал",
    "ОП": "опоздал",
    "ОСВ": "освобождён от посещения",
}

NOT_ABSENCE_CODES = {"ОСВ", "ОП"}

# Обновленный парсер: теперь понимает точки и дефисы (пересдачи)
_MARK_RE = re.compile(r"^(\d+([.,]\d+)?|[.\-])$")
_TOKEN_RE = re.compile(r"\S+")

def _cell_text(html_fragment: str) -> str:
    text = re.sub(r"<br\s*/?>", " ", html_fragment, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("&nbsp;", " ").replace("&quot;", '"')
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    return re.sub(r"\s+", " ", text).strip()

class _TableExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: List[Dict[str, Any]] = []
        self._open: List[Dict[str, Any]] = []
        self._row: Optional[List[Dict[str, Any]]] = None
        self._cell: Optional[Dict[str, Any]] = None

    def handle_starttag(self, tag: str, attrs: List[tuple]) -> None:
        attributes = dict(attrs)
        if tag == "table":
            table = {"class": attributes.get("class", ""), "rows": []}
            self.tables.append(table)
            self._open.append(table)
        elif tag == "tr" and self._open:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = {
                "class": attributes.get("class", ""),
                "colspan": _int(attributes.get("colspan"), 1),
                "rowspan": _int(attributes.get("rowspan"), 1),
                "text": "",
            }
        elif tag == "br" and self._cell is not None:
            self._cell["text"] += " "

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._cell["text"] = re.sub(r"\s+", " ", self._cell["text"]).strip()
            self._row.append(self._cell)
            self._cell = None
        elif tag == "tr" and self._row is not None and self._open:
            self._open[-1]["rows"].append(self._row)
            self._row = None
        elif tag == "table" and self._open:
            self._open.pop()

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell["text"] += data

def _int(value: Optional[str], default: int) -> int:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return default

def extract_tables(html: str) -> List[Dict[str, Any]]:
    parser = _TableExtractor()
    parser.feed(html)
    parser.close()
    return parser.tables

def parse_student_total(html: str) -> Dict[str, Any]:
    table = None
    for candidate in extract_tables(html):
        if "table-print" in (candidate.get("class") or ""):
            table = candidate
            break
    if table is None:
        return {"subjects": [], "days": [], "term": "", "student": "", "klass": "", "as_of": ""}

    rows = [row for row in table["rows"] if row]
    if len(rows) < 3:
        return {"subjects": [], "days": [], "term": "", "student": "", "klass": "", "as_of": ""}

    plain = _cell_text(html)
    year_match = re.search(r"Учебный год:\s*(\d{4})/(\d{4})", plain)
    year = int(year_match.group(1)) if year_match else None
    term_match = re.search(r"Учебный период:\s*(.*?)\s*Период:", plain)
    term = term_match.group(1).strip() if term_match else ""
    student_match = re.search(r'data-sheet-name="([^"]+)"', html)
    student = student_match.group(1).strip() if student_match else ""
    if not student:
        student_match = re.search(r"Ученик:\s*([А-ЯЁ][^\d]{2,60}?)\s+(?:Предмет|УП —|Состояние на|$)", plain)
        student = student_match.group(1).strip() if student_match else ""
    class_match = re.search(r"Класс:\s*(.*?)\s*Учебный период:", plain)
    klass = class_match.group(1).strip() if class_match else ""
    as_of_match = re.search(r"Состояние на\s*(\d{1,2}\.\d{1,2}\.\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?)", plain)
    as_of = as_of_match.group(1).strip() if as_of_match else ""

    month_columns: List[tuple] = []
    for cell in rows[0]:
        if cell["rowspan"] > 1: continue
        month = _MONTHS.get(cell["text"].strip().lower())
        if month:
            month_columns.append((month, cell["colspan"]))
    day_numbers = [int(cell["text"]) for cell in rows[1] if cell["text"].isdigit()]
    if not month_columns or not day_numbers:
        return {"subjects": [], "days": [], "term": term, "student": student, "klass": klass, "as_of": ""}

    dates: List[str] = []
    for month, span in month_columns:
        for _ in range(span):
            dates.append(month)
    days: List[str] = []
    for index, month in enumerate(dates):
        if index >= len(day_numbers): break
        day = day_numbers[index]
        day_year = year or 2000
        if month <= 7 and year:
            day_year = year + 1
        days.append(f"{day_year:04d}-{month:02d}-{day:02d}")

    subjects: List[Dict[str, Any]] = []
    for row in rows[2:]:
        if not row or "cell-text" not in (row[0].get("class") or ""):
            continue
        name = row[0]["text"]
        if not name: continue
        cells = row[1:]
        marks: List[Dict[str, str]] = []
        absences: List[Dict[str, str]] = []
        for index, cell in enumerate(cells[: len(days)]):
            value = cell["text"].strip()
            if not value: continue
            date = days[index]
            for token in _TOKEN_RE.findall(value):
                if _MARK_RE.match(token):
                    marks.append({"date": date, "value": token.replace(",", ".")})
                elif token.upper() in ATTENDANCE_CODES or token.isalpha():
                    absences.append({"date": date, "code": token})
        average = ""
        final = ""
        tail = cells[len(days):]
        if len(tail) >= 1:
            average = tail[0]["text"].strip()
        if len(tail) >= 2:
            final = tail[1]["text"].strip()
        subjects.append({
            "name": name,
            "marks": marks,
            "absences": absences,
            "average": average.replace(",", ".") if average else "",
            "final": final,
        })

    return {
        "subjects": subjects,
        "days": days,
        "term": term,
        "student": student,
        "klass": klass,
        "as_of": as_of,
    }