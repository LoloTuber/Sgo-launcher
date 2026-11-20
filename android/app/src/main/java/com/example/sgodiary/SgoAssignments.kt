package com.example.sgodiary

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Подробности задания (оценки или домашнего задания).
 *
 * Ответ кэшируется на 30 минут: клик по оценке не должен каждый раз
 * ходить в СГО. Заранее загруженные подробности лежат в том же кэше.
 */
internal fun SgoClient.getAssignmentJson(id: Int): String {
    synchronized(detailsCache) {
        val cached = detailsCache[id]
        if (cached != null && System.currentTimeMillis() - cached.first < DETAILS_CACHE_TTL) {
            return cached.second
        }
    }

    val json = fetchAssignmentJson(id)
    synchronized(detailsCache) { detailsCache[id] = Pair(System.currentTimeMillis(), json) }
    return json
}

/**
 * Заранее загружает подробности заданий в фоне.
 * Ответ клиенту не ждёт — к моменту клика подробности уже в кэше.
 */
internal fun SgoClient.preloadAssignments(ids: List<Int>) {
    val wanted = ids.filter { it > 0 }.distinct()
    if (wanted.isEmpty()) return
    Thread({
        for (id in wanted) {
            try {
                getAssignmentJson(id)
            } catch (e: Exception) {
                Log.w("SGO_DETAILS", "Не удалось загрузить подробности $id: ${e.message}")
            }
        }
    }, "sgo-details-preload").start()
}

private fun SgoClient.fetchAssignmentJson(id: Int): String {
    val info = get("student/diary/assigns/$id", mapOf("studentId" to studentId!!))
    val res = JSONObject().apply { put("ok", true); put("id", id) }

    // Пустое значение приходит как JSON null, а иногда — строкой «null».
    // Такой текст показывать нельзя, иначе в интерфейсе висит «null».
    fun cleanText(value: String?): String {
        val text = (value ?: "").trim()
        return if (text.isEmpty() || text.equals("null", true) || text.equals("none", true)) "" else text
    }

    val teachers = JSONArray()
    info.optJSONArray("teachers")?.let { tArr ->
        for (i in 0 until tArr.length()) {
            val name = cleanText(tArr.getJSONObject(i).optString("name"))
            if (name.isNotEmpty()) teachers.put(name)
        }
    }
    res.put("teachers", teachers)

    // Комментарий учителя. В СГО он может лежать в разных полях.
    val details = JSONArray()
    val detailTexts = ArrayList<String>()
    for (key in listOf("description", "problemName", "activityName", "comment")) {
        if (!info.has(key) || info.isNull(key)) continue
        val text = cleanText(info.optString(key))
        if (text.isNotEmpty() && !detailTexts.contains(text)) detailTexts.add(text)
    }
    for (text in detailTexts) details.put(text)
    res.put("details", details)

    val files = JSONArray()
    info.optJSONArray("attachments")?.let { fArr ->
        for (i in 0 until fArr.length()) {
            val obj = fArr.getJSONObject(i)
            val name = cleanText(obj.optString("name").ifEmpty { obj.optString("originalFileName") })
            if (name.isNotEmpty()) files.put(name)
        }
    }
    res.put("files", files)

    // Предмет из группы («9г/Алгебра»).
    val subject = cleanText(info.optJSONObject("subjectGroup")?.optString("name"))
    res.put("subject", subject)

    // Тема задания.
    res.put("topic", cleanText(info.optString("assignmentName")))

    // Дата урока: СГО отдаёт «2026-11-12T00:00:00».
    val rawDate = info.optString("date")
    res.put("date", if (rawDate.length >= 10) rawDate.substring(0, 10) else "")

    // Вес задания (x10, x20, x30).
    res.put("weight", info.optInt("weight", 0))

    // Средний балл класса по этому заданию.
    val average = info.optDouble("averageMark", Double.NaN)
    res.put("averageMark", if (average.isNaN()) JSONObject.NULL else average)

    // Оценки класса: сколько человек получило каждую отметку.
    val markStats = JSONArray()
    info.optJSONArray("markStats")?.let { statsArr ->
        for (i in 0 until statsArr.length()) {
            val stat = statsArr.optJSONObject(i) ?: continue
            if (!stat.has("mark") || !stat.has("count")) continue
            markStats.put(JSONObject().apply {
                put("mark", stat.optString("mark"))
                put("count", stat.optInt("count", 0))
                put("percentage", stat.optInt("percentage", 0))
            })
        }
    }
    res.put("markStats", markStats)

    return res.toString()
}