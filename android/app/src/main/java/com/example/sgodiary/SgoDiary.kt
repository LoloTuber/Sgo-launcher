package com.example.sgodiary

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

/**
 * Домашнее задание к ближайшему учебному дню.
 *
 * Начинаем с завтрашнего дня. Если в этот день уроков нет (выходной, праздник,
 * карантин), ищем ближайший учебный день в пределах 8 дней вперёд — так же,
 * как в ПК-версии. В этом случае подпись сообщает, что показан ближайший
 * учебный день.
 */
internal fun SgoClient.getHomeworkForTomorrow(): JSONObject {
    val hwJson = JSONObject()
    val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
    try {
        val base = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        val tomorrow = (base.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, 1) }
        val tomorrowStr = sdf.format(tomorrow.time)

        var foundDate: Calendar? = null
        var foundLessons: JSONArray? = null

        for (offset in 0..7) {
            val day = (tomorrow.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, offset) }
            val lessons = diaryLessonsFor(day, sdf)
            if (lessons != null && lessons.length() > 0) {
                foundDate = day
                foundLessons = lessons
                break
            }
        }

        val lessonsOut = JSONArray()
        var tasksCount = 0
        val lessons = foundLessons
        if (lessons != null) {
            for (i in 0 until lessons.length()) {
                val lesson = lessons.getJSONObject(i)
                val tasks = JSONArray()
                val rawTasks = lesson.optJSONArray("tasks") ?: JSONArray()
                for (j in 0 until rawTasks.length()) {
                    val task = rawTasks.getJSONObject(j)
                    val text = task.optString("text")
                    if (text.isNotEmpty()) {
                        tasks.put(JSONObject().apply {
                            put("id", task.optInt("id"))
                            put("text", text)
                            put("type", task.optString("type"))
                        })
                    }
                }
                tasksCount += tasks.length()
                lessonsOut.put(JSONObject().apply {
                    put("number", lesson.optInt("number"))
                    put("subject", lesson.optString("subject"))
                    put("room", lesson.optString("room"))
                    put("start", lesson.optString("start"))
                    put("end", lesson.optString("end"))
                    put("tasks", tasks)
                })
            }
        }

        val date = foundDate
        if (date == null) {
            hwJson.put("lessons", JSONArray())
            hwJson.put("date", tomorrowStr)
            hwJson.put("label", ruDayLabel(tomorrow))
            hwJson.put("isTomorrow", true)
            hwJson.put("tasksCount", 0)
            hwJson.put("note", "Ближайших учебных дней не найдено.")
        } else {
            val dateStr = sdf.format(date.time)
            val isTomorrow = dateStr == tomorrowStr
            hwJson.put("lessons", lessonsOut)
            hwJson.put("date", dateStr)
            hwJson.put("label", ruDayLabel(date))
            hwJson.put("isTomorrow", isTomorrow)
            hwJson.put("tasksCount", tasksCount)
            if (!isTomorrow) {
                hwJson.put("note", "Завтра уроков нет — показываю ближайший учебный день.")
            }
        }
    } catch (e: AuthExpiredException) {
        throw e
    } catch (e: Exception) {
        Log.w("SGO_QUICK", "Не удалось собрать домашнее задание: ${e.message}")
        hwJson.put("lessons", JSONArray())
        hwJson.put("label", "Завтра")
        hwJson.put("isTomorrow", true)
        hwJson.put("tasksCount", 0)
    }
    return hwJson
}

/** Понедельник недели, к которой относится указанный день. */
private fun mondayOfWeek(day: Calendar): Calendar {
    val cal = Calendar.getInstance().apply { time = day.time }
    // Calendar.DAY_OF_WEEK: пн=2 … вс=7. Считаем смещение явно — set(DAY_OF_WEEK)
    // в разных версиях Calendar ведёт себя по-разному.
    cal.add(Calendar.DAY_OF_YEAR, -((cal.get(Calendar.DAY_OF_WEEK) + 5) % 7))
    return cal
}

/**
 * Уроки указанного дня из дневника. null — такого дня в дневнике нет
 * (выходной или каникулы). Неделя берётся из кэша дневника, поэтому
 * дополнительных запросов обычно не делается.
 */
private fun SgoClient.diaryLessonsFor(day: Calendar, sdf: SimpleDateFormat): JSONArray? {
    val weekStart = sdf.format(mondayOfWeek(day).time)
    val week = JSONObject(getDiaryJson(weekStart))
    val days = week.optJSONArray("days") ?: JSONArray()
    val dateStr = sdf.format(day.time)
    for (i in 0 until days.length()) {
        val d = days.getJSONObject(i)
        if (d.optString("date").take(10) == dateStr) {
            return d.optJSONArray("lessons") ?: JSONArray()
        }
    }
    return null
}

/** «16 ноября, понедельник» */
private fun ruDayLabel(day: Calendar): String {
    val month = MONTHS[day.get(Calendar.MONTH)]
    val weekday = WEEKDAYS[day.get(Calendar.DAY_OF_WEEK) - 1]
    return "${day.get(Calendar.DAY_OF_MONTH)} $month, $weekday"
}

internal fun SgoClient.getQuickJson(): String {
    val response = JSONObject()
    response.put("ok", true)

    // Дашборд нужен для шапки и среднего балла, но его недоступность не должна
    // ломать домашнее задание — отдаём то, что есть.
    val dash = try {
        get("student-diary/dashboard", mapOf("studentId" to studentId!!, "version" to "2"))
    } catch (e: AuthExpiredException) {
        throw e
    } catch (e: Exception) {
        Log.w("SGO_QUICK", "Дашборд СГО недоступен: ${e.message}")
        JSONObject()
    }

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

internal fun SgoClient.getDiaryJson(weekStr: String?): String {
    val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
    val monday = if (weekStr != null)
        sdf.parse(weekStr)!!
    else {
        // Понедельник текущей недели. Считаем явно: set(DAY_OF_WEEK) в разных
        // версиях Calendar ведёт себя по-разному, а от этого зависит и ключ кэша.
        val cal = Calendar.getInstance()
        cal.set(Calendar.HOUR_OF_DAY, 0)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        cal.add(Calendar.DAY_OF_YEAR, -((cal.get(Calendar.DAY_OF_WEEK) + 5) % 7))
        cal.time
    }
    val weekStart = sdf.format(monday)

    // Свежая копия из кэша — отвечаем сразу, не дёргая СГО.
    synchronized(diaryCache) {
        val cached = diaryCache[weekStart]
        if (cached != null && System.currentTimeMillis() - cached.first < DIARY_CACHE_TTL) {
            return cached.second
        }
    }

    val calEnd = Calendar.getInstance().apply { time = monday; add(Calendar.DAY_OF_YEAR, 6) }
    val weekEnd = sdf.format(calEnd.time)

    val diary = get(
        "student/diary",
        mapOf(
            "studentId" to studentId!!,
            "weekStart" to weekStart,
            "weekEnd" to weekEnd,
            "yearId" to yearId!!
        )
    )

    val response = JSONObject()
    response.put("ok", true)
    response.put("weekStart", weekStart)
    response.put("weekEnd", weekEnd)

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

        val lessonList = mutableListOf<JSONObject>()
        val lessons = day.optJSONArray("lessons") ?: JSONArray()
        for (j in 0 until lessons.length()) {
            val l = lessons.getJSONObject(j)
            val lJson = JSONObject()
            lJson.put("number", l.optInt("number"))
            lJson.put("subject", l.optString("subjectName"))
            lJson.put("room", l.optString("room"))
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

        lessonList.sortBy { it.optInt("number", 0) }
        val lessonsArr = JSONArray()
        for (lesson in lessonList) lessonsArr.put(lesson)
        dayJson.put("lessons", lessonsArr)
        dayObjects.add(Pair(dateStr, dayJson))
    }

    dayObjects.sortBy { it.first }
    val daysArr = JSONArray()
    for ((_, dayJson) in dayObjects) daysArr.put(dayJson)
    response.put("days", daysArr)

    val json = response.toString()
    synchronized(diaryCache) { diaryCache[weekStart] = Pair(System.currentTimeMillis(), json) }
    return json
}

/**
 * Предзагрузка дневника на weeks недель назад и вперёд.
 * Делается в отдельном потоке: основные экраны не должны ждать.
 */
internal fun SgoClient.preloadDiary(weeks: Int) {
    val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
    val cal = Calendar.getInstance()
    cal.set(Calendar.HOUR_OF_DAY, 0)
    cal.set(Calendar.MINUTE, 0)
    cal.set(Calendar.SECOND, 0)
    cal.set(Calendar.MILLISECOND, 0)
    val offset = (cal.get(Calendar.DAY_OF_WEEK) + 5) % 7 // пн=1 -> 0, вс=7 -> 6
    cal.add(Calendar.DAY_OF_YEAR, -offset)

    Thread({
        for (i in -weeks..weeks) {
            if (i == 0) continue
            val target = Calendar.getInstance().apply {
                time = cal.time
                add(Calendar.DAY_OF_YEAR, 7 * i)
            }
            try {
                getDiaryJson(sdf.format(target.time))
            } catch (e: Exception) {
                Log.w("SGO_PRELOAD", "Не удалось загрузить неделю: ${e.message}")
            }
        }
    }, "sgo-preload").start()
}

internal fun SgoClient.getScheduleJson(weekStr: String?): String {
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