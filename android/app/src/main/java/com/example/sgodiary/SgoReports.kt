package com.example.sgodiary

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

internal fun SgoClient.getStudentTotalHtml(termId: String? = null): String? {
    return try {
        getStudentTotalHtmlOnce(termId)
    } catch (e: AuthExpiredException) {
        throw e
    } catch (e: Exception) {
        Log.e("SGO_REPORT", "report attempt 1 failed: ${e.message}", e)
        try {
            Thread.sleep(500)
            getStudentTotalHtmlOnce(termId)
        } catch (e2: AuthExpiredException) {
            throw e2
        } catch (e2: Exception) {
            Log.e("SGO_REPORT", "report attempt 2 failed: ${e2.message}", e2)
            null
        }
    }
}

private fun SgoClient.getStudentTotalHtmlOnce(termId: String?): String? {
    var info = get("reports/StudentTotal")
    var filterSources = info.optJSONArray("filterSources") ?: JSONArray()
    Log.i("SGO_REPORT", "getStudentTotalHtml: termId=$termId, filterSources=${filterSources.length()}")

    // SGO иногда возвращает {} сразу после логина — повторяем через 500 мс.
    if (filterSources.length() == 0) {
        Thread.sleep(500)
        info = get("reports/StudentTotal")
        filterSources = info.optJSONArray("filterSources") ?: JSONArray()
        Log.i("SGO_REPORT", "getStudentTotalHtml retry: filterSources=${filterSources.length()}")
    }

    val selectedData = JSONArray()
    // СГО режет данные отчёта по фильтру «period» (интервал дат), а не по
    // TERMID: без явных дат смена триместра не меняет ничего. Поэтому
    // вместе с TERMID всегда передаём даты выбранного периода.
    val periodValue = periodFilterValue(termId)
    if (periodValue.isNotEmpty()) {
        Log.i("SGO_REPORT", "period для termId=$termId: $periodValue")
    }
    for (i in 0 until filterSources.length()) {
        val source = filterSources.getJSONObject(i)
        val filterId = source.optString("filterId")
        if (filterId.isEmpty()) continue

        var value = source.optString("defaultValue")
        if (filterId == "TERMID" && termId != null) value = termId
        if (filterId == "period" && periodValue.isNotEmpty()) value = periodValue
        if (value.isEmpty()) continue

        var text = ""
        val items = source.optJSONArray("items")
        if (items != null) {
            for (j in 0 until items.length()) {
                val item = items.getJSONObject(j)
                if (item.optString("value") == value) { text = item.optString("title"); break }
            }
        }
        selectedData.put(JSONObject().apply {
            put("filterId", filterId)
            put("filterValue", value)
            put("filterText", text)
        })
    }

    val params = JSONArray().apply {
        put(JSONObject().apply { put("name", "SCHOOLYEARID"); put("value", yearId ?: "") })
        put(JSONObject().apply { put("name", "SERVERTIMEZONE") })
        put(JSONObject().apply { put("name", "FULLSCHOOLNAME"); put("value", organizationName) })
        put(JSONObject().apply { put("name", "DATEFORMAT"); put("value", "d\u0001mm\u0001yy\u0001.") })
        if (!termId.isNullOrEmpty()) {
            put(JSONObject().apply { put("name", "TERMID"); put("value", termId) })
        }
        if (periodValue.isNotEmpty()) {
            put(JSONObject().apply { put("name", "period"); put("value", periodValue) })
        }
    }

    val reqBody = JSONObject().apply {
        put("selectedData", selectedData)
        put("params", params)
    }.toString()

    val queueReq = getBuilder(baseUrl + "reports/StudentTotal/queue")
        .header("at", token ?: "")
        .post(reqBody.toRequestBody("application/json".toMediaType()))
        .build()

    val queueRes = client.newCall(queueReq).execute()
    val queueJson = JSONObject(queueRes.body?.string() ?: "{}")
    val taskId = queueJson.optInt("taskId", -1)
    val queueKey = queueJson.optString("queueKey", "report-v2")
    Log.i("SGO_REPORT", "queue: taskId=$taskId, queueKey=$queueKey")
    if (taskId == -1) return null

    val fileId = awaitReportFile(taskId, queueKey) ?: return null
    Log.i("SGO_REPORT", "fileId=$fileId")

    // ВАЖНО: файл отчёта скачивается с токеном "at". Без него СГО
    // отвечает {"message":"Нет доступа"} вместо HTML — отчёт не парсится.
    val fileReq = getBuilder(baseUrl + "files/$fileId")
        .header("at", token ?: "")
        .build()
    val fileRes = client.newCall(fileReq).execute()
    val body = fileRes.body?.string() ?: ""

    // СГО иногда отдаёт вместо отчёта JSON с ошибкой — сообщаем текст ошибки,
    // а не «таблица не найдена».
    if (body.trimStart().startsWith("{")) {
        val message = try {
            JSONObject(body).optString("message")
        } catch (e: Exception) { "" }
        Log.w("SGO_REPORT", "СГО не отдал отчёт: ${body.take(200)}")
        throw IllegalStateException(
            if (message.isNotEmpty()) "СГО не отдал отчёт: $message" else "СГО не отдал отчёт"
        )
    }
    return body
}

/** Ждёт в очереди SignalR готовый файл отчёта. Возвращает fileId или null. */
private fun SgoClient.awaitReportFile(taskId: Int, queueKey: String): String? {
    val wsUrl = "wss://sgo.volganet.ru/webapi/signalr/queueHub?at=$token"
    val latch = CountDownLatch(1)
    var fileId: String? = null

    val ws = wsClient.newWebSocket(Request.Builder().url(wsUrl).build(), object : WebSocketListener() {
        var isHandshakeDone = false
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send("{\"protocol\":\"json\",\"version\":1}\u001e")
        }
        override fun onMessage(webSocket: WebSocket, text: String) {
            for (part in text.split("\u001e")) {
                if (part.isBlank()) continue
                try {
                    val json = JSONObject(part)
                    if (!isHandshakeDone) {
                        isHandshakeDone = true
                        val startCmd = JSONObject().apply {
                            put("type", 1).put("invocationId", "1").put("target", "startTaskAsync")
                            put("arguments", JSONArray().put(taskId).put(queueKey))
                        }
                        webSocket.send(startCmd.toString() + "\u001e")
                        continue
                    }
                    when (json.optString("target")) {
                        "complete" -> {
                            val args = json.optJSONArray("arguments")
                            if (args != null && args.length() > 0) {
                                val arg0 = args.getJSONObject(0)
                                if (arg0.has("data")) fileId = arg0.optString("data")
                            }
                            latch.countDown()
                        }
                        "error" -> {
                            Log.w("SGO_REPORT", "queue error: $json")
                            latch.countDown()
                        }
                    }
                } catch (e: Exception) { }
            }
        }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w("SGO_REPORT", "ws failure: ${t.message}")
            latch.countDown()
        }
    })

    latch.await(30, TimeUnit.SECONDS)
    ws.close(1000, "done")
    return fileId
}

// Пробелы в отчёте СГО бывают обычные, неразрывные (nbsp), узкие и т.д.
// В Java \s не матчит \u00A0, поэтому нормализуем пробелы явно.
private val CELL_SPACE_REGEX = Regex("[\\s\\u00A0\\u202F\\u2007\\u2009\\u200B]+")
// Числовая часть токена: «5», «4», «3,5» — выделяется из слипшихся «5Н».
private val NUM_PART_REGEX = Regex("(\\d+(?:[.,]\\d+)?)")
// Числовая оценка в ячейке отчёта.
private val NUMERIC_MARK_REGEX = Regex("^\\d+([.,]\\d+)?$")
// Коды пропусков в разных написаниях приводим к одному виду.
private val CODE_ALIASES = mapOf(
    "Н" to "Н", "НП" to "НП",
    "УП" to "УП",
    "Б" to "Б", "БК" to "Б",
    "ОТ" to "ОТ", "ОП" to "ОП", "ОСВ" to "ОСВ"
)

/**
 * Разбивает содержимое ячейки отчёта на токены оценок и кодов пропусков.
 *
 * СГО пишет в одной ячейке и оценку, и код пропуска, причём они могут быть
 * разделены обычным пробелом, неразрывным (&nbsp;) или идти слитно («5Н»).
 */
private fun splitCellTokens(value: String): List<String> {
    val text = CELL_SPACE_REGEX.replace(value, " ").trim()
    if (text.isEmpty()) return emptyList()
    val tokens = ArrayList<String>()
    for (raw in text.split(" ")) {
        if (raw.isEmpty()) continue
        for (part in NUM_PART_REGEX.split(raw)) {
            val p = part.trim()
            if (p.isNotEmpty()) tokens.add(p)
        }
    }
    return tokens
}

/** «н.п.» / «Б/К» / «НП» → канонический код пропуска. */
internal fun normalizeAttendanceCode(token: String): String {
    val raw = token.filter { it.isLetterOrDigit() }.uppercase()
    return CODE_ALIASES[raw] ?: raw
}

internal fun SgoClient.parseReportHtml(html: String): String {
    Log.i("SGO_REPORT", "parseReportHtml: html.len=${html.length}")
    val doc = Jsoup.parse(html)
    val table = doc.select("table.table-print").firstOrNull()
    if (table == null) {
        Log.w("SGO_REPORT", "table.table-print NOT FOUND. HTML preview: ${html.take(600)}")
        return "{\"ok\":false, \"error\":\"Таблица не найдена\"}"
    }
    val rows = table.select("tr")
    if (rows.size < 3) {
        Log.w("SGO_REPORT", "rows=${rows.size} < 3")
        return "{\"ok\":false, \"error\":\"Мало строк\"}"
    }

    val plainText = doc.text()
    val yearMatch = Regex("Учебный год:\\s*(\\d{4})/(\\d{4})").find(plainText)
    val year = yearMatch?.groupValues?.get(1)?.toIntOrNull() ?: 0
    val termMatch = Regex("Учебный период:\\s*(.*?)\\s*Период:").find(plainText)
    val termStr = termMatch?.groupValues?.get(1)?.trim() ?: ""
    val asOfMatch = Regex("Состояние на\\s*(\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)").find(plainText)
    val asOf = asOfMatch?.groupValues?.get(1) ?: ""

    val monthColumns = mutableListOf<Pair<Int, Int>>()
    for (cell in rows[0].select("td, th")) {
        if ((cell.attr("rowspan").toIntOrNull() ?: 1) > 1) continue
        val monthNum = MONTHS_MAP[cell.text().trim().lowercase()]
        if (monthNum != null) {
            monthColumns.add(Pair(monthNum, cell.attr("colspan").toIntOrNull() ?: 1))
        }
    }

    val dayNumbers = mutableListOf<Int>()
    for (cell in rows[1].select("td, th")) {
        cell.text().trim().toIntOrNull()?.let { dayNumbers.add(it) }
    }

    if (monthColumns.isEmpty() || dayNumbers.isEmpty()) {
        Log.w("SGO_REPORT", "months=${monthColumns.size}, days=${dayNumbers.size}")
        return "{\"ok\":false, \"error\":\"Не найдены месяцы или дни\"}"
    }

    val dates = mutableListOf<String>()
    var dayIdx = 0
    for ((month, span) in monthColumns) {
        for (i in 0 until span) {
            if (dayIdx >= dayNumbers.size) break
            val day = dayNumbers[dayIdx]
            var dayYear = if (year > 0) year else 2000
            if (month <= 7 && year > 0) dayYear = year + 1
            dates.add(String.format("%04d-%02d-%02d", dayYear, month, day))
            dayIdx++
        }
    }

    val subjectsMap = mutableMapOf<String, MutableList<JSONObject>>()
    val tailsMap = mutableMapOf<String, Pair<String, String>>()
    val absences = JSONArray()
    val absentCounts = mutableMapOf<String, Int>()
    var totalMarks = 0
    var allSum = 0.0
    val counts = mutableMapOf("5" to 0, "4" to 0, "3" to 0, "2" to 0)
    var diagPrinted = false

    for (i in 2 until rows.size) {
        val cells = rows[i].select("td, th")
        if (cells.isEmpty()) continue
        val nameCell = cells[0]
        if (!nameCell.hasClass("cell-text")) continue
        val subjectName = nameCell.text().trim()
        if (subjectName.isEmpty()) continue

        val tailStart = 1 + dates.size

        // Диагностика: показываем ВСЕ хвостовые колонки первой строки —
        // так видно, есть ли там колонка «годовая».
        if (!diagPrinted) {
            diagPrinted = true
            val tailCells = (tailStart until cells.size).joinToString(" | ") {
                "[$it]='${cells[it].text().trim()}'"
            }
            Log.i(
                "SGO_REPORT",
                "row '$subjectName': cells=${cells.size}, dates=${dates.size}, " +
                        "tailStart=$tailStart, tails=[$tailCells]"
            )
        }

        val termAvgFromReport = if (cells.size > tailStart) cells[tailStart].text().trim() else ""
        val finalFromReport = if (cells.size > tailStart + 1) cells[tailStart + 1].text().trim() else ""
        if (termAvgFromReport.isNotEmpty() || finalFromReport.isNotEmpty()) {
            tailsMap[subjectName] = Pair(termAvgFromReport, finalFromReport)
        }

        for (j in 0 until dates.size) {
            if (j + 1 >= cells.size) break
            val cell = cells[j + 1]
            val cellText = cell.text().trim()
            if (cellText.isEmpty()) continue
            val date = dates[j]
            for (token in splitCellTokens(cellText)) {
                when {
                    NUMERIC_MARK_REGEX.matches(token) -> {
                        val valStr = token.replace(",", ".")
                        val mJson = JSONObject().apply {
                            put("value", valStr); put("date", date); put("topic", "Оценка")
                            put("type", ""); put("weight", 1)
                        }
                        subjectsMap.getOrPut(subjectName) { mutableListOf() }.add(mJson)
                        val v = valStr.toDoubleOrNull() ?: 0.0
                        if (v > 0) {
                            totalMarks++; allSum += v
                            if (counts.containsKey(valStr)) counts[valStr] = counts[valStr]!! + 1
                        }
                    }
                    token == DOT_MARK || token == DASH_MARK -> {
                        val mJson = JSONObject().apply {
                            put("value", DOT_MARK); put("date", date); put("topic", "Точка")
                            put("type", ""); put("weight", 1)
                        }
                        subjectsMap.getOrPut(subjectName) { mutableListOf() }.add(mJson)
                        // Долг в расчёте среднего равен «2» (вес уточним из дневника).
                        totalMarks++; allSum += DEBT_MARK_VALUE
                    }
                    else -> {
                        val code = normalizeAttendanceCode(token)
                        if (code.isNotEmpty() && code.length <= 4 && code.all { it.isLetter() }) {
                            val isCounted = !NOT_ABSENCE_CODES.contains(code)
                            absences.put(JSONObject().apply {
                                put("date", date); put("code", code)
                                put("label", ATTENDANCE_CODES[code] ?: code)
                                put("subject", subjectName); put("counted", isCounted)
                            })
                            if (isCounted) absentCounts[code] = (absentCounts[code] ?: 0) + 1
                        }
                    }
                }
            }
        }
    }

    val response = JSONObject()
    response.put("ok", true)
    response.put("term", if (termStr.isNotEmpty()) termStr else termName)
    val overallAvg = if (totalMarks > 0) round2(allSum / totalMarks) else 0.0
    response.put("average", overallAvg)
    response.put("marksCount", totalMarks)
    response.put("counts", JSONObject(counts as Map<*, *>))
    response.put("asOf", if (asOf.isNotEmpty()) asOf
    else SimpleDateFormat("dd.MM.yyyy HH:mm", Locale.getDefault()).format(Date()))

    val subjsArr = JSONArray()
    for ((name, marks) in subjectsMap) {
        marks.sortByDescending { it.optString("date") }
        var sum = 0.0; var wSum = 0
        for (m in marks) {
            val v = markNumber(m.optString("value")) ?: continue
            val w = m.optInt("weight", 1).coerceAtLeast(1)
            sum += v * w
            wSum += w
        }
        val weighted = if (wSum > 0) round2(sum / wSum) else 0.0
        val tail = tailsMap[name]
        subjsArr.put(JSONObject().apply {
            put("name", name)
            put("marks", JSONArray(marks))
            put("average", weighted)
            // Собственное взвешенное среднее (веса уточняются из дневника).
            put("weightedAverage", weighted)
            put("weight", wSum)
            put("count", marks.size)
            put("marksCount", marks.size)
            if (tail != null) {
                if (tail.first.isNotEmpty()) put("termAverage", tail.first.replace(',', '.'))
                if (tail.second.isNotEmpty()) put("final", tail.second.replace(',', '.'))
            }
        })
    }
    response.put("subjects", subjsArr)

    val attJson = JSONObject()
    attJson.put("items", absences)
    attJson.put("counts", JSONObject(absentCounts as Map<*, *>))
    attJson.put("total", absentCounts.values.sum())
    // Отчёт разобран — данные о посещаемости доступны (пусто = пропусков нет).
    attJson.put("available", true)
    response.put("attendance", attJson)
    response.put("days", JSONArray(dates))

    Log.i(
        "SGO_REPORT",
        "parseReportHtml OK: subjects=${subjsArr.length()}, days=${dates.size}, " +
                "term='${response.optString("term")}', tails=${tailsMap.size} " +
                "(${tailsMap.keys.take(3).joinToString(", ")})"
    )

    return response.toString()
}