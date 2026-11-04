package com.example.sgodiary

import android.util.Log
import android.util.Base64
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.Charset
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt
import org.jsoup.Jsoup

class SimpleCookieJar : CookieJar {
    private val cookieStore = mutableMapOf<String, List<Cookie>>()
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) { cookieStore[url.host] = cookies }
    override fun loadForRequest(url: HttpUrl): List<Cookie> { return cookieStore[url.host] ?: emptyList() }
}

// Сессия СГО истекла (HTTP 401/403). Сервер по этой ошибке повторно входит
// сохранёнными логином/паролем и повторяет запрос.
class AuthExpiredException : Exception("AUTH_EXPIRED")

class SgoClient {
    private val cookieJar = SimpleCookieJar()
    private val logging = HttpLoggingInterceptor { message -> Log.d("SGO_HTTP", message) }.apply { level = HttpLoggingInterceptor.Level.BODY }

    private val client = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .addInterceptor(logging)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val wsClient = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val baseUrl = "https://sgo.volganet.ru/webapi/"

    private var token: String? = null
    // Время истечения access token (epoch, секунды). 0 — неизвестно.
    private var tokenExpiresAt: Long = 0
    var studentId: String? = null
    var yearId: String? = null
    var studentName: String = ""
    var termName: String = ""
    var termStart: String = ""
    var termEnd: String = ""
    var organizationName: String = ""

    private val WEEKDAYS = arrayOf("воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота")
    private val MONTHS = arrayOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")

    private val MONTHS_MAP = mapOf(
        "январь" to 1, "февраль" to 2, "март" to 3, "апрель" to 4, "май" to 5, "июнь" to 6,
        "июль" to 7, "август" to 8, "сентябрь" to 9, "октябрь" to 10, "ноябрь" to 11, "декабрь" to 12
    )

    private val ATTENDANCE_CODES = mapOf(
        "Н" to "не был", "НП" to "пропуск по неуважительной причине",
        "УП" to "пропуск по уважительной причине", "Б" to "пропустил по болезни",
        "ОТ" to "отсутствовал", "ОП" to "опоздал", "ОСВ" to "освобождён от посещения"
    )
    private val NOT_ABSENCE_CODES = setOf("ОСВ", "ОП")

    // «Точка» (работа не оценена / долг). Такие отметки показываем,
    // но в средний балл и в количество оценок не включаем.
    private val DOT_MARK = "."
    private val DASH_MARK = "-"

    // Веса оценок из дневника: отчёт StudentTotal их не содержит.
    // Кэш immutable: при каждой сборке ответа списки копируются, чтобы
    // повторный запрос не «выедал» веса.
    private data class MarkWeight(val weight: Int, val id: Int, val type: String)
    private data class WeightEntry(val subject: String, val date: String, val value: String, val info: MarkWeight)
    private val weightsCache = mutableMapOf<String, List<WeightEntry>>()

    fun isLoggedIn() = token != null
    fun reset() {
        token = null
        tokenExpiresAt = 0
        synchronized(weightsCache) { weightsCache.clear() }
    }

    // Токен СГО живёт ограниченное время. Если он истёк, запросы молча
    // возвращают пустые данные, поэтому проверяем срок заранее.
    fun isTokenExpired(): Boolean {
        if (token == null) return true
        return tokenExpiresAt > 0 && System.currentTimeMillis() / 1000 >= tokenExpiresAt - 60
    }

    private fun parseTokenExpiry(jwt: String): Long {
        return try {
            val payload = jwt.split(".").getOrNull(1) ?: return 0
            val bytes = Base64.decode(payload, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            JSONObject(String(bytes, Charsets.UTF_8)).optLong("exp", 0)
        } catch (e: Exception) {
            0
        }
    }

    private fun round2(value: Double): Double = (value * 100.0).roundToInt() / 100.0

    private fun getBuilder(url: String): Request.Builder {
        return Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            .header("Referer", "https://sgo.volganet.ru/")
            .header("Accept", "application/json, text/plain, */*")
    }

    private fun toHex(bytes: ByteArray): String {
        val hexChars = "0123456789abcdef"
        val result = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val i = b.toInt() and 0xff
            result.append(hexChars[i ushr 4]).append(hexChars[i and 0x0f])
        }
        return result.toString()
    }

    @Synchronized
    fun login(loginStr: String, passStr: String, schoolId: String = "1244"): Boolean {
        try {
            client.newCall(getBuilder(baseUrl + "logindata").build()).execute().close()
            val metaReq = getBuilder(baseUrl + "auth/getdata").post("".toRequestBody("text/plain".toMediaType())).build()
            val metaRes = client.newCall(metaReq).execute()
            val metaBody = metaRes.body?.string() ?: "{}"
            val metaJson = JSONObject(metaBody)
            val salt = metaJson.optString("salt")
            Log.i("SGO_LOGIN", "getdata: http=${metaRes.code}, salt='$salt', body=$metaBody")
            if (salt.isEmpty()) return false

            val md5 = MessageDigest.getInstance("MD5")
            val pw2 = toHex(md5.digest(passStr.toByteArray(Charset.forName("windows-1251"))))
            val finalPw2 = toHex(md5.digest((salt + pw2).toByteArray(Charsets.UTF_8)))
            val pw = finalPw2.substring(0, passStr.length)

            val formBuilder = FormBody.Builder()
                .add("loginType", "1").add("scid", schoolId).add("un", loginStr).add("pw", pw).add("pw2", finalPw2)

            val keys = metaJson.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (key != "salt") formBuilder.add(key, metaJson.optString(key))
            }

            Log.i("SGO_LOGIN", "Отправка формы: un='$loginStr' (len=${loginStr.length}), passLen=${passStr.length}, pw=$pw, pw2=$finalPw2")
            val loginRes = client.newCall(getBuilder(baseUrl + "login").post(formBuilder.build()).build()).execute()
            val loginBody = loginRes.body?.string() ?: ""
            Log.i("SGO_LOGIN", "Ответ от СГО: http=${loginRes.code}, body=$loginBody")

            val loginJson = JSONObject(loginBody)
            val at = loginJson.optString("at")
            if (at.isEmpty()) return false
            token = at
            // Срок жизни берём из JWT accessToken (поле at — короткий идентификатор, не JWT).
            val jwt = loginJson.optString("accessToken")
            tokenExpiresAt = if (jwt.isNotEmpty()) parseTokenExpiry(jwt) else 0
            Log.i("SGO_LOGIN", "Токен получен, истекает через ${(tokenExpiresAt - System.currentTimeMillis() / 1000)} c")

            val initData = get("student/diary/init")
            val students = initData.optJSONArray("students") ?: JSONArray()
            if (students.length() == 0) return false

            val currentIdx = initData.optInt("currentStudentId", 0)
            val student = students.getJSONObject(if (currentIdx < students.length()) currentIdx else 0)
            studentId = student.optString("studentId")
            studentName = student.optString("nickName", student.optString("fullName", "Ученик"))

            val yearData = get("years/current", mapOf("studentId" to studentId!!))
            yearId = yearData.optString("id")

            val contextObj = get("context")
            organizationName = contextObj.optString("organizationName")

            val dash = get("student-diary/dashboard", mapOf("studentId" to studentId!!, "version" to "2"))
            termName = dash.optString("termName")
            termStart = dash.optString("termStartDate")
            termEnd = dash.optString("termEndDate")

            return true
        } catch (e: Exception) {
            Log.e("SGO", "Ошибка login", e)
            return false
        }
    }

    private fun get(path: String, params: Map<String, String>? = null): JSONObject {
        val urlBuilder = (baseUrl + path).toHttpUrlOrNull()?.newBuilder()
        if (params != null && urlBuilder != null) {
            for ((k, v) in params) urlBuilder.addQueryParameter(k, v)
        }
        val req = getBuilder(urlBuilder!!.build().toString()).header("at", token ?: "").build()
        val res = client.newCall(req).execute()
        if (res.code == 401 || res.code == 403) {
            res.close()
            token = null
            tokenExpiresAt = 0
            Log.i("SGO_LOGIN", "Сессия истекла (HTTP ${res.code}) для $path")
            throw AuthExpiredException()
        }
        return try { JSONObject(res.body?.string() ?: "{}") } catch (e: Exception) { JSONObject() }
    }

    private fun getHomeworkForTomorrow(): JSONObject {
        val hwJson = JSONObject()
        try {
            val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
            val tomorrow = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, 1) }
            val tomorrowStr = sdf.format(tomorrow.time)

            val monday = Calendar.getInstance().apply { time = tomorrow.time; set(Calendar.DAY_OF_WEEK, Calendar.MONDAY) }
            val weekStart = sdf.format(monday.time)
            val calEnd = Calendar.getInstance().apply { time = monday.time; add(Calendar.DAY_OF_YEAR, 6) }
            val weekEnd = sdf.format(calEnd.time)

            val diary = get("student/diary", mapOf("studentId" to studentId!!, "weekStart" to weekStart, "weekEnd" to weekEnd, "yearId" to yearId!!))
            val days = diary.optJSONArray("weekDays") ?: JSONArray()

            var targetDay: JSONObject? = null
            for (i in 0 until days.length()) {
                val d = days.getJSONObject(i)
                if (d.optString("date").startsWith(tomorrowStr)) { targetDay = d; break }
            }

            if (targetDay != null) {
                val lessonsArr = JSONArray()
                val lessons = targetDay.optJSONArray("lessons") ?: JSONArray()
                for (i in 0 until lessons.length()) {
                    val l = lessons.getJSONObject(i)
                    val tasks = JSONArray()
                    val assigns = l.optJSONArray("assignments") ?: JSONArray()
                    for (j in 0 until assigns.length()) {
                        val a = assigns.getJSONObject(j)
                        val text = a.optString("assignmentName")
                        if (text.isNotEmpty()) {
                            tasks.put(JSONObject().apply {
                                put("id", a.optInt("id"))
                                put("text", text)
                                put("type", a.optString("typeName"))
                            })
                        }
                    }
                    if (tasks.length() > 0) {
                        lessonsArr.put(JSONObject().apply {
                            put("number", l.optInt("number"))
                            put("subject", l.optString("subjectName"))
                            put("start", l.optString("startTime").take(5))
                            put("end", l.optString("endTime").take(5))
                            put("tasks", tasks)
                        })
                    }
                }
                hwJson.put("lessons", lessonsArr)
                hwJson.put("isTomorrow", true)
            } else {
                hwJson.put("lessons", JSONArray())
                hwJson.put("note", "Завтра уроков нет (или это выходной).")
            }
            hwJson.put("label", "${tomorrow.get(Calendar.DAY_OF_MONTH)} ${MONTHS[tomorrow.get(Calendar.MONTH)]}")
        } catch (e: Exception) {
            hwJson.put("lessons", JSONArray())
            hwJson.put("label", "Завтра")
        }
        return hwJson
    }

    fun getQuickJson(): String {
        val dash = get("student-diary/dashboard", mapOf("studentId" to studentId!!, "version" to "2"))
        val response = JSONObject()
        response.put("ok", true)

        val studentJson = JSONObject()
        studentJson.put("name", studentName)
        studentJson.put("class", dash.optString("className"))
        studentJson.put("term", termName)
        val avgMarks = dash.optJSONObject("averageMarks")
        val commonAvg = round2(avgMarks?.optDouble("commonAverageMark") ?: 0.0)
        studentJson.put("average", commonAvg)
        response.put("student", studentJson)

        val resultsJson = JSONObject()
        resultsJson.put("common", commonAvg)
        val subjs = JSONArray()
        val subjArr = avgMarks?.optJSONArray("subjectAverageMarks")
        if (subjArr != null) {
            for (i in 0 until subjArr.length()) {
                val s = subjArr.getJSONObject(i)
                subjs.put(JSONObject().apply {
                    put("name", s.optString("subjectName"))
                    put("average", round2(s.optDouble("averageMark")))
                })
            }
        }
        resultsJson.put("subjects", subjs)
        response.put("results", resultsJson)

        response.put("homework", getHomeworkForTomorrow())
        response.put("updated", SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.getDefault()).format(Date()))

        return response.toString()
    }

    fun getDiaryJson(weekStr: String?): String {
        val monday = if (weekStr != null) SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).parse(weekStr)!! else {
            val cal = Calendar.getInstance(); cal.set(Calendar.DAY_OF_WEEK, Calendar.MONDAY); cal.time
        }
        val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
        val weekStart = sdf.format(monday)
        val calEnd = Calendar.getInstance().apply { time = monday; add(Calendar.DAY_OF_YEAR, 6) }
        val weekEnd = sdf.format(calEnd.time)

        val diary = get(
            "student/diary",
            mapOf("studentId" to studentId!!, "weekStart" to weekStart, "weekEnd" to weekEnd, "yearId" to yearId!!)
        )

        val response = JSONObject()
        response.put("ok", true)
        response.put("weekStart", weekStart)
        response.put("weekEnd", weekEnd)

        // Собираем дни в список, чтобы отсортировать. СГО может отдавать weekDays
        // в произвольном порядке — без сортировки «Дневник» и «Расписание» показывают
        // дни вперемешку (баг телефонной версии).
        val dayObjects = mutableListOf<Pair<String, JSONObject>>()

        val weekDays = diary.optJSONArray("weekDays") ?: JSONArray()
        for (i in 0 until weekDays.length()) {
            val day = weekDays.getJSONObject(i)
            val dateStr = day.optString("date").take(10)
            if (dateStr.length != 10) continue
            val date = sdf.parse(dateStr) ?: continue
            val calDay = Calendar.getInstance().apply { time = date }

            val dayJson = JSONObject()
            dayJson.put("date", dateStr)
            dayJson.put("weekday", WEEKDAYS[calDay.get(Calendar.DAY_OF_WEEK) - 1])

            // Собираем уроки тоже в список для сортировки по номеру.
            val lessonList = mutableListOf<JSONObject>()
            val lessons = day.optJSONArray("lessons") ?: JSONArray()
            for (j in 0 until lessons.length()) {
                val l = lessons.getJSONObject(j)
                val lJson = JSONObject()
                lJson.put("number", l.optInt("number"))
                lJson.put("subject", l.optString("subjectName"))
                lJson.put("start", l.optString("startTime").take(5))
                lJson.put("end", l.optString("endTime").take(5))

                val tasks = JSONArray()
                val marks = JSONArray()
                val assigns = l.optJSONArray("assignments") ?: JSONArray()
                for (k in 0 until assigns.length()) {
                    val a = assigns.getJSONObject(k)
                    val topic = a.optString("assignmentName")

                    if (topic.isNotEmpty()) {
                        tasks.put(JSONObject().apply {
                            put("id", a.optInt("id"))
                            put("text", topic)
                            put("type", a.optString("typeName"))
                        })
                    }

                    val mark = a.optJSONObject("mark")
                    if (mark != null && mark.has("mark")) {
                        val valStr = mark.optString("mark").trim()
                        // «Точка» (долг/невыставленная оценка) приходит как "." или "-".
                        if (valStr.toDoubleOrNull() != null || valStr == DOT_MARK || valStr == DASH_MARK) {
                            marks.put(JSONObject().apply {
                                put("id", a.optInt("id"))
                                put("value", valStr)
                                put("date", if (mark.has("date")) mark.optString("date").take(10) else dateStr)
                                put("topic", topic)
                                put("type", a.optString("typeName"))
                                put("weight", a.optInt("weight", 1))
                            })
                        }
                    }
                }
                lJson.put("tasks", tasks)
                lJson.put("marks", marks)
                lessonList.add(lJson)
            }

            // Уроки: 0-й («Разговоры о важном») → 1-й → 2-й → ...
            lessonList.sortBy { it.optInt("number", 0) }
            val lessonsArr = JSONArray()
            for (lesson in lessonList) lessonsArr.put(lesson)
            dayJson.put("lessons", lessonsArr)

            dayObjects.add(Pair(dateStr, dayJson))
        }

        // Дни по ISO-дате: YYYY-MM-DD сортируется лексикографически == хронологически.
        dayObjects.sortBy { it.first }

        val daysArr = JSONArray()
        for ((_, dayJson) in dayObjects) daysArr.put(dayJson)
        response.put("days", daysArr)

        return response.toString()
    }

    fun getScheduleJson(weekStr: String?): String {
        val diaryJson = JSONObject(getDiaryJson(weekStr))
        val days = diaryJson.optJSONArray("days") ?: JSONArray()
        for (i in 0 until days.length()) {
            val day = days.getJSONObject(i)
            val lessons = day.optJSONArray("lessons") ?: JSONArray()
            for (j in 0 until lessons.length()) {
                lessons.getJSONObject(j).remove("tasks")
                lessons.getJSONObject(j).remove("marks")
            }
        }
        return diaryJson.toString()
    }

    private fun getStudentTotalHtml(termId: String? = null): String? {
        try {
            val info = get("reports/StudentTotal")
            val filterSources = info.optJSONArray("filterSources") ?: JSONArray()

            val selectedData = JSONArray()
            for (i in 0 until filterSources.length()) {
                val source = filterSources.getJSONObject(i)
                val filterId = source.optString("filterId")
                if (filterId.isEmpty()) continue

                var value = source.optString("defaultValue")
                if (filterId == "TERMID" && termId != null) {
                    value = termId
                }
                if (value.isEmpty()) continue

                var text = ""
                val items = source.optJSONArray("items")
                if (items != null) {
                    for (j in 0 until items.length()) {
                        val item = items.getJSONObject(j)
                        if (item.optString("value") == value) {
                            text = item.optString("title")
                            break
                        }
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

            if (taskId == -1) return null

            val wsUrl = "wss://sgo.volganet.ru/webapi/signalr/queueHub?at=$token"
            val latch = CountDownLatch(1)
            var fileId: String? = null

            val request = Request.Builder().url(wsUrl).build()
            val ws = wsClient.newWebSocket(request, object : WebSocketListener() {
                var isHandshakeDone = false
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("{\"protocol\":\"json\",\"version\":1}\u001e")
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val parts = text.split("\u001e")
                    for (part in parts) {
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
                            if (json.optString("target") == "complete") {
                                val args = json.optJSONArray("arguments")
                                if (args != null && args.length() > 0) {
                                    val arg0 = args.getJSONObject(0)
                                    if (arg0.has("data")) fileId = arg0.optString("data")
                                }
                                latch.countDown()
                            } else if (json.optString("target") == "error") {
                                latch.countDown()
                            }
                        } catch (e: Exception) {}
                    }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    latch.countDown()
                }
            })

            latch.await(30, TimeUnit.SECONDS)
            ws.close(1000, "done")

            if (fileId == null) return null

            val fileReq = getBuilder(baseUrl + "files/$fileId").build()
            val fileRes = client.newCall(fileReq).execute()
            return fileRes.body?.string()
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            Log.e("SGO", "Ошибка генерации отчета", e)
            return null
        }
    }

    private fun parseReportHtml(html: String): String {
        val doc = Jsoup.parse(html)
        val table = doc.select("table.table-print").firstOrNull() ?: return "{\"ok\":false, \"error\":\"Таблица не найдена\"}"
        val rows = table.select("tr")
        if (rows.size < 3) return "{\"ok\":false, \"error\":\"Мало строк\"}"

        val plainText = doc.text()
        val yearMatch = Regex("Учебный год:\\s*(\\d{4})/(\\d{4})").find(plainText)
        val year = yearMatch?.groupValues?.get(1)?.toIntOrNull() ?: 0
        val termMatch = Regex("Учебный период:\\s*(.*?)\\s*Период:").find(plainText)
        val termStr = termMatch?.groupValues?.get(1)?.trim() ?: ""
        val asOfMatch = Regex("Состояние на\\s*(\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)").find(plainText)
        val asOf = asOfMatch?.groupValues?.get(1) ?: ""

        val monthColumns = mutableListOf<Pair<Int, Int>>()
        val row0Cells = rows[0].select("td, th")
        for (cell in row0Cells) {
            if ((cell.attr("rowspan").toIntOrNull() ?: 1) > 1) continue
            val monthNum = MONTHS_MAP[cell.text().trim().lowercase()]
            if (monthNum != null) {
                val colspan = cell.attr("colspan").toIntOrNull() ?: 1
                monthColumns.add(Pair(monthNum, colspan))
            }
        }

        val dayNumbers = mutableListOf<Int>()
        val row1Cells = rows[1].select("td, th")
        for (cell in row1Cells) {
            val text = cell.text().trim()
            if (text.toIntOrNull() != null) dayNumbers.add(text.toInt())
        }

        if (monthColumns.isEmpty() || dayNumbers.isEmpty()) {
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
        val absences = JSONArray()
        val absentCounts = mutableMapOf<String, Int>()
        var totalMarks = 0
        var allSum = 0.0
        val counts = mutableMapOf("5" to 0, "4" to 0, "3" to 0, "2" to 0)

        for (i in 2 until rows.size) {
            val row = rows[i]
            val cells = row.select("td, th")
            if (cells.isEmpty()) continue

            val nameCell = cells[0]
            if (!nameCell.hasClass("cell-text")) continue

            val subjectName = nameCell.text().trim()
            if (subjectName.isEmpty()) continue

            for (j in 0 until dates.size) {
                if (j + 1 >= cells.size) break
                val cell = cells[j + 1]
                val cellText = cell.text().trim()
                if (cellText.isEmpty()) continue

                val date = dates[j]
                val tokens = cellText.split(Regex("\\s+"))
                for (token in tokens) {
                    if (Regex("^\\d+([.,]\\d+)?$").matches(token)) {
                        val valStr = token.replace(",", ".")
                        val mJson = JSONObject().apply {
                            put("value", valStr); put("date", date); put("topic", "Оценка"); put("type", ""); put("weight", 1)
                        }
                        if (!subjectsMap.containsKey(subjectName)) subjectsMap[subjectName] = mutableListOf()
                        subjectsMap[subjectName]!!.add(mJson)
                        val v = valStr.toDoubleOrNull() ?: 0.0
                        if (v > 0) {
                            totalMarks++; allSum += v
                            if (counts.containsKey(valStr)) counts[valStr] = counts[valStr]!! + 1
                        }
                    } else if (token == DOT_MARK || token == DASH_MARK) {
                        // «Точка» — не оценка: показываем отдельно, в среднее не включаем.
                        val mJson = JSONObject().apply {
                            put("value", DOT_MARK); put("date", date); put("topic", "Точка"); put("type", ""); put("weight", 1)
                        }
                        if (!subjectsMap.containsKey(subjectName)) subjectsMap[subjectName] = mutableListOf()
                        subjectsMap[subjectName]!!.add(mJson)
                    } else if (token.uppercase() in ATTENDANCE_CODES.keys || token.all { it.isLetter() }) {
                        val code = token.uppercase()
                        val isCounted = !NOT_ABSENCE_CODES.contains(code)
                        absences.put(JSONObject().apply {
                            put("date", date); put("code", code); put("label", ATTENDANCE_CODES[code] ?: code); put("subject", subjectName); put("counted", isCounted)
                        })
                        if (isCounted) absentCounts[code] = (absentCounts[code] ?: 0) + 1
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
        response.put("asOf", if (asOf.isNotEmpty()) asOf else SimpleDateFormat("dd.MM.yyyy HH:mm", Locale.getDefault()).format(Date()))

        val subjsArr = JSONArray()
        for ((name, marks) in subjectsMap) {
            marks.sortByDescending { it.optString("date") }
            var sum = 0.0; var wSum = 0
            for (m in marks) { val v = m.optDouble("value"); if (v > 0) { sum += v * m.optInt("weight", 1); wSum += m.optInt("weight", 1) } }
            subjsArr.put(JSONObject().apply { put("name", name); put("marks", JSONArray(marks)); put("average", if (wSum > 0) round2(sum / wSum) else 0.0); put("count", marks.size) })
        }
        response.put("subjects", subjsArr)

        val attJson = JSONObject()
        attJson.put("items", absences)
        attJson.put("counts", JSONObject(absentCounts as Map<*, *>))
        attJson.put("total", absentCounts.values.sum())
        response.put("attendance", attJson)
        // Дни периода нужны, чтобы запросить веса из дневника за нужный термин.
        response.put("days", JSONArray(dates))
        return response.toString()
    }

    // --- Веса оценок -------------------------------------------------------

    private fun normalizeSubjectName(name: String): String =
        name.lowercase(Locale.getDefault())
            .replace('ё', 'е')
            .replace(Regex("\\s+"), " ")
            .trim()

    /** "5", "5.0", "5,0" -> "5" — единый вид для сопоставления. */
    private fun normalizeMarkValue(value: String): String {
        val normalized = value.trim().replace(',', '.')
        val number = normalized.toDoubleOrNull() ?: return normalized
        return if (number % 1.0 == 0.0) number.toInt().toString() else normalized
    }

    private fun weightKey(subject: String, date: String, value: String) = "$subject|$date|$value"

    /** Один запрос student/diary за весь период — как в ПК-версии. */
    private fun fetchWeightEntries(start: String, end: String): List<WeightEntry> {
        val cacheKey = "$start|$end"
        synchronized(weightsCache) { weightsCache[cacheKey]?.let { return it } }

        val params = mutableMapOf(
            "studentId" to (studentId ?: ""),
            "weekStart" to start,
            "weekEnd" to end
        )
        yearId?.takeIf { it.isNotEmpty() }?.let { params["yearId"] = it }
        val diary = get("student/diary", params)

        val entries = mutableListOf<WeightEntry>()
        val weekDays = diary.optJSONArray("weekDays") ?: JSONArray()
        for (i in 0 until weekDays.length()) {
            val day = weekDays.getJSONObject(i)
            val date = day.optString("date").take(10)
            if (date.length != 10) continue

            val lessons = day.optJSONArray("lessons") ?: continue
            for (j in 0 until lessons.length()) {
                val lesson = lessons.getJSONObject(j)
                val subject = normalizeSubjectName(lesson.optString("subjectName"))
                if (subject.isEmpty()) continue

                val assignments = lesson.optJSONArray("assignments") ?: continue
                for (k in 0 until assignments.length()) {
                    val assignment = assignments.getJSONObject(k)
                    val mark = assignment.optJSONObject("mark") ?: continue
                    if (!mark.has("mark")) continue
                    val value = normalizeMarkValue(mark.optString("mark"))
                    if (value.isEmpty() || value == "0") continue
                    entries.add(
                        WeightEntry(
                            subject = subject,
                            date = date,
                            value = value,
                            info = MarkWeight(
                                weight = assignment.optInt("weight", 1).coerceAtLeast(1),
                                id = assignment.optInt("id", 0),
                                type = assignment.optString("typeName")
                            )
                        )
                    )
                }
            }
        }

        synchronized(weightsCache) {
            if (weightsCache.size > 8) weightsCache.clear()
            weightsCache[cacheKey] = entries
        }
        return entries
    }

    private fun takeMarkWeight(
        index: MutableMap<String, MutableList<MarkWeight>>,
        subject: String,
        date: String,
        value: String
    ): MarkWeight? {
        val key = normalizeSubjectName(subject)
        val candidates = mutableListOf(key)
        val head = key.substringBefore('/').trim()
        if (head.isNotEmpty() && head != key) candidates.add(head)

        for (candidate in candidates) {
            val bucket = index[weightKey(candidate, date, value)]
            if (!bucket.isNullOrEmpty()) return bucket.removeAt(0)
        }

        // Мягкий вариант: отчёт и дневник по-разному уточняют название.
        for ((indexKey, bucket) in index) {
            if (bucket.isEmpty()) continue
            val parts = indexKey.split("|", limit = 3)
            if (parts.size != 3) continue
            if (parts[1] == date && parts[2] == value &&
                (parts[0].contains(key) || key.contains(parts[0]))) {
                return bucket.removeAt(0)
            }
        }
        return null
    }

    /** Проставляет веса/типы/ids из дневника и пересчитывает средние. */
    private fun enrichGradesWithWeights(grades: JSONObject) {
        val days = grades.optJSONArray("days") ?: JSONArray()
        var start = ""
        var end = ""
        for (i in 0 until days.length()) {
            val day = days.optString(i).take(10)
            if (day.length != 10) continue
            if (start.isEmpty() || day < start) start = day
            if (end.isEmpty() || day > end) end = day
        }
        if (start.isEmpty()) {
            start = termStart.take(10)
            end = termEnd.take(10)
        }
        if (start.length != 10 || end.length != 10) return

        val entries = fetchWeightEntries(start, end)
        if (entries.isEmpty()) return

        val index = mutableMapOf<String, MutableList<MarkWeight>>()
        for (entry in entries) {
            index.getOrPut(weightKey(entry.subject, entry.date, entry.value)) { mutableListOf() }
                .add(entry.info)
        }

        val subjects = grades.optJSONArray("subjects") ?: return
        var totalWeighted = 0.0
        var totalWeight = 0

        for (i in 0 until subjects.length()) {
            val subject = subjects.getJSONObject(i)
            val subjectName = subject.optString("name")
            val marks = subject.optJSONArray("marks") ?: continue
            var sum = 0.0
            var weightSum = 0

            for (j in 0 until marks.length()) {
                val mark = marks.getJSONObject(j)
                val info = takeMarkWeight(
                    index,
                    subjectName,
                    mark.optString("date").take(10),
                    normalizeMarkValue(mark.optString("value"))
                )
                if (info != null) {
                    mark.put("weight", info.weight)
                    if (info.id > 0) mark.put("id", info.id)
                    if (info.type.isNotEmpty()) mark.put("type", info.type)
                }

                val value = mark.optString("value").replace(',', '.').toDoubleOrNull() ?: continue
                if (value <= 0) continue
                val weight = mark.optInt("weight", 1)
                sum += value * weight
                weightSum += weight
                totalWeighted += value * weight
                totalWeight += weight
            }
            if (weightSum > 0) subject.put("average", round2(sum / weightSum))
        }

        if (totalWeight > 0) grades.put("average", round2(totalWeighted / totalWeight))
    }

    fun getGradesJson(termId: String? = null): String {
        val html = try { getStudentTotalHtml(termId) } catch (e: AuthExpiredException) { throw e } catch (e: Exception) { null }
        if (html != null) {
            try {
                val parsed = JSONObject(parseReportHtml(html))
                if (parsed.optBoolean("ok", false)) {
                    try {
                        enrichGradesWithWeights(parsed)
                    } catch (e: AuthExpiredException) {
                        throw e
                    } catch (e: Exception) {
                        Log.w("SGO", "Не удалось применить веса оценок", e)
                    }
                    return parsed.toString()
                }
            } catch (e: Exception) {}
        }
        return getGradesJsonFallback(termId)
    }

    private fun getGradesJsonFallback(termId: String? = null): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
        val start = sdf.parse(termStart) ?: Date()
        val today = Calendar.getInstance().time
        val termEndDate = sdf.parse(termEnd) ?: today
        val end = if (termEndDate.after(today)) today else termEndDate

        val subjectsMap = mutableMapOf<String, MutableList<JSONObject>>()
        var totalMarks = 0; var allWeighted = 0.0; var allWeight = 0
        val counts = mutableMapOf("5" to 0, "4" to 0, "3" to 0, "2" to 0)
        val absences = JSONArray()
        val absentCounts = mutableMapOf<String, Int>()

        val cal = Calendar.getInstance().apply { time = start; set(Calendar.DAY_OF_WEEK, Calendar.MONDAY) }
        val calEnd = Calendar.getInstance().apply { time = end }

        while (cal.time <= calEnd.time) {
            val wStart = sdf.format(cal.time)
            val calWEnd = Calendar.getInstance().apply { time = cal.time; add(Calendar.DAY_OF_YEAR, 6) }
            val wEnd = sdf.format(calWEnd.time)

            val diary = get("student/diary", mapOf("studentId" to studentId!!, "weekStart" to wStart, "weekEnd" to wEnd, "yearId" to yearId!!))
            val days = diary.optJSONArray("weekDays") ?: JSONArray()

            for (i in 0 until days.length()) {
                val dayJson = days.getJSONObject(i)
                val dayDate = dayJson.optString("date").take(10)
                val lessons = dayJson.optJSONArray("lessons") ?: JSONArray()

                for (j in 0 until lessons.length()) {
                    val l = lessons.getJSONObject(j)
                    val subj = l.optString("subjectName")
                    val lMarks = l.optJSONArray("marks")
                    if (lMarks != null) {
                        for (k in 0 until lMarks.length()) {
                            val mObj = lMarks.getJSONObject(k)
                            val valStr = mObj.optString("mark").trim()
                            val markDate = mObj.optString("date").take(10)
                            if (valStr.isNotEmpty()) {
                                val num = valStr.toDoubleOrNull()
                                if (num != null || valStr == DOT_MARK || valStr == DASH_MARK) {
                                    val isDot = num == null
                                    val mJson = JSONObject().apply {
                                        put("value", if (isDot) DOT_MARK else valStr)
                                        put("date", markDate)
                                        put("topic", if (isDot) "Точка" else "Оценка")
                                        put("type", "")
                                        put("weight", 1)
                                    }
                                    if (!subjectsMap.containsKey(subj)) subjectsMap[subj] = mutableListOf()
                                    subjectsMap[subj]!!.add(mJson)
                                    if (num != null) {
                                        totalMarks++; allWeighted += num; allWeight += 1
                                        if (counts.containsKey(valStr)) counts[valStr] = counts[valStr]!! + 1
                                    }
                                } else {
                                    val code = valStr.uppercase()
                                    val isCounted = !NOT_ABSENCE_CODES.contains(code)
                                    absences.put(JSONObject().apply { put("date", markDate); put("code", code); put("label", ATTENDANCE_CODES[code] ?: code); put("subject", subj); put("counted", isCounted) })
                                    if (isCounted) absentCounts[code] = (absentCounts[code] ?: 0) + 1
                                }
                            }
                        }
                    }
                    val assigns = l.optJSONArray("assignments") ?: JSONArray()
                    for (k in 0 until assigns.length()) {
                        val a = assigns.getJSONObject(k)
                        val mark = a.optJSONObject("mark")
                        if (mark != null && mark.has("mark")) {
                            val valStr = mark.optString("mark").trim()
                            val markDate = if (mark.has("date")) mark.optString("date").take(10) else dayDate
                            val num = valStr.toDoubleOrNull()
                            if (num != null || valStr == DOT_MARK || valStr == DASH_MARK) {
                                val isDot = num == null
                                val weight = a.optInt("weight", 1).coerceAtLeast(1)
                                val mJson = JSONObject().apply {
                                    put("value", if (isDot) DOT_MARK else valStr)
                                    put("date", markDate)
                                    put("topic", a.optString("assignmentName"))
                                    put("type", a.optString("typeName"))
                                    put("weight", weight)
                                    put("id", a.optInt("id", 0))
                                }
                                if (!subjectsMap.containsKey(subj)) subjectsMap[subj] = mutableListOf()
                                subjectsMap[subj]!!.add(mJson)
                                if (num != null) {
                                    totalMarks++; allWeighted += num * weight; allWeight += weight
                                    if (counts.containsKey(valStr)) counts[valStr] = counts[valStr]!! + 1
                                }
                            }
                        }
                    }
                }
            }
            cal.add(Calendar.DAY_OF_YEAR, 7)
        }

        val response = JSONObject()
        response.put("ok", true)
        response.put("term", termName)
        response.put("average", if (allWeight > 0) round2(allWeighted / allWeight) else 0.0)
        response.put("marksCount", totalMarks)
        response.put("counts", JSONObject(counts as Map<*, *>))
        response.put("asOf", SimpleDateFormat("dd.MM.yyyy HH:mm", Locale.getDefault()).format(Date()))

        val subjsArr = JSONArray()
        for ((name, marks) in subjectsMap) {
            marks.sortByDescending { it.optString("date") }
            var sum = 0.0; var wSum = 0
            for (m in marks) { val v = m.optDouble("value"); if (v > 0) { sum += v * m.optInt("weight", 1); wSum += m.optInt("weight", 1) } }
            subjsArr.put(JSONObject().apply { put("name", name); put("marks", JSONArray(marks)); put("average", if (wSum > 0) round2(sum / wSum) else 0.0); put("count", marks.size) })
        }
        response.put("subjects", subjsArr)

        val attJson = JSONObject()
        attJson.put("items", absences)
        attJson.put("counts", JSONObject(absentCounts as Map<*, *>))
        attJson.put("total", absentCounts.values.sum())
        response.put("attendance", attJson)
        return response.toString()
    }

    fun getTermsJson(): String {
        val arr = JSONArray()
        try {
            val res = get("reports/StudentTotal")
            val sources = res.optJSONArray("filterSources") ?: JSONArray()
            for (i in 0 until sources.length()) {
                val src = sources.getJSONObject(i)
                if (src.optString("filterId") == "TERMID") {
                    val items = src.optJSONArray("items") ?: JSONArray()
                    for (j in 0 until items.length()) {
                        val item = items.getJSONObject(j)
                        arr.put(JSONObject().apply { put("id", item.optString("value")); put("name", item.optString("title")) })
                    }
                    break
                }
            }
        } catch (e: Exception) {}

        if (arr.length() == 0) arr.put(JSONObject().apply { put("id", "current"); put("name", termName) })
        return JSONObject().put("ok", true).put("terms", arr).toString()
    }

    fun getAssignmentJson(id: Int): String {
        val info = get("student/diary/assigns/$id", mapOf("studentId" to studentId!!))
        val res = JSONObject().apply { put("ok", true); put("id", id) }
        val teachers = JSONArray()
        val tArr = info.optJSONArray("teachers")
        if (tArr != null) { for (i in 0 until tArr.length()) teachers.put(tArr.getJSONObject(i).optString("name")) }
        res.put("teachers", teachers)
        val details = JSONArray()
        if (info.has("description")) details.put(info.optString("description"))
        res.put("details", details)
        val files = JSONArray()
        val fArr = info.optJSONArray("attachments")
        if (fArr != null) { for (i in 0 until fArr.length()) files.put(fArr.getJSONObject(i).optString("name")) }
        res.put("files", files)
        return res.toString()
    }
}