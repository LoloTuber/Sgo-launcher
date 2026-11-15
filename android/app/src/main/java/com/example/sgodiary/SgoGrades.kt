package com.example.sgodiary

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

/**
 * Успеваемость за период.
 *
 * Сборка за термин — это десятки запросов к СГО (отчёт + недели дневника),
 * поэтому результат кэшируем на 10 минут: повторные переходы на вкладку
 * «Успеваемость» / «Посещаемость» / «Аналитика» не тормозят интерфейс.
 */
internal fun SgoClient.getGradesJson(termId: String? = null): String {
    val cacheKey = "grades:${termId ?: "current"}"
    synchronized(jsonCache) {
        val cached = jsonCache[cacheKey]
        if (cached != null && System.currentTimeMillis() - cached.first < DATA_CACHE_TTL) {
            Log.i("SGO_GRADES", "Кэш успеваемости: $cacheKey")
            return cached.second
        }
    }
    val result = buildGradesJson(termId)
    synchronized(jsonCache) { jsonCache[cacheKey] = Pair(System.currentTimeMillis(), result) }
    return result
}

private fun SgoClient.buildGradesJson(termId: String?): String {
    val html = try {
        getStudentTotalHtml(termId)
    } catch (e: AuthExpiredException) {
        throw e
    } catch (e: Exception) {
        Log.w("SGO_GRADES", "Отчёт StudentTotal недоступен: ${e.message}")
        null
    }
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
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) { }
    }
    return getGradesJsonFallback(termId)
}

internal fun SgoClient.getGradesJsonFallback(termId: String? = null): String {
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

    val cal = Calendar.getInstance().apply {
        time = start
        set(Calendar.DAY_OF_WEEK, Calendar.MONDAY)
    }
    val calEnd = Calendar.getInstance().apply { time = end }

    while (cal.time <= calEnd.time) {
        val wStart = sdf.format(cal.time)
        val wEnd = sdf.format(
            Calendar.getInstance().apply { time = cal.time; add(Calendar.DAY_OF_YEAR, 6) }.time
        )
        val diary = get(
            "student/diary",
            mapOf(
                "studentId" to studentId!!,
                "weekStart" to wStart, "weekEnd" to wEnd,
                "yearId" to yearId!!
            )
        )
        val days = diary.optJSONArray("weekDays") ?: JSONArray()

        for (i in 0 until days.length()) {
            val dayJson = days.getJSONObject(i)
            val dayDate = dayJson.optString("date").take(10)
            val lessons = dayJson.optJSONArray("lessons") ?: JSONArray()

            for (j in 0 until lessons.length()) {
                val l = lessons.getJSONObject(j)
                val subj = l.optString("subjectName")

                l.optJSONArray("marks")?.let { lMarks ->
                    for (k in 0 until lMarks.length()) {
                        val mObj = lMarks.getJSONObject(k)
                        val valStr = mObj.optString("mark").trim()
                        val markDate = mObj.optString("date").take(10)
                        if (valStr.isEmpty()) continue
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
                            subjectsMap.getOrPut(subj) { mutableListOf() }.add(mJson)
                            // Долг («.»/«-») считаем как «2» — с весом 1 у этой отметки.
                            val numeric = markNumber(valStr)
                            if (numeric != null) {
                                totalMarks++; allWeighted += numeric; allWeight += 1
                                if (num != null && counts.containsKey(valStr)) counts[valStr] = counts[valStr]!! + 1
                            }
                        } else {
                            val code = normalizeAttendanceCode(valStr)
                            if (code.isNotEmpty() && code.length <= 4 && code.all { it.isLetter() }) {
                                val isCounted = !NOT_ABSENCE_CODES.contains(code)
                                absences.put(JSONObject().apply {
                                    put("date", markDate); put("code", code)
                                    put("label", ATTENDANCE_CODES[code] ?: code)
                                    put("subject", subj); put("counted", isCounted)
                                })
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
                            subjectsMap.getOrPut(subj) { mutableListOf() }.add(mJson)
                            // Долг («.»/«-») считаем как «2» с весом задания.
                            val numeric = markNumber(valStr)
                            if (numeric != null) {
                                totalMarks++; allWeighted += numeric * weight; allWeight += weight
                                if (num != null && counts.containsKey(valStr)) counts[valStr] = counts[valStr]!! + 1
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
        for (m in marks) {
            val v = markNumber(m.optString("value")) ?: continue
            val w = m.optInt("weight", 1).coerceAtLeast(1)
            sum += v * w
            wSum += w
        }
        val weighted = if (wSum > 0) round2(sum / wSum) else 0.0
        subjsArr.put(JSONObject().apply {
            put("name", name)
            put("marks", JSONArray(marks))
            put("average", weighted)
            // Собственное взвешенное среднее и «вес» предмета (сумма весов оценок).
            put("weightedAverage", weighted)
            put("weight", wSum)
            put("count", marks.size)
        })
    }
    response.put("subjects", subjsArr)

    val attJson = JSONObject()
    attJson.put("items", absences)
    attJson.put("counts", JSONObject(absentCounts as Map<*, *>))
    attJson.put("total", absentCounts.values.sum())
    // Это запасной путь (дневник вместо отчёта СГО) — коды пропусков он не даёт,
    // поэтому честно говорим, что данных о посещаемости нет.
    attJson.put("available", false)
    response.put("attendance", attJson)
    return response.toString()
}