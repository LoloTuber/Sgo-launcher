package com.example.sgodiary

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

internal fun SgoClient.getHomeworkForTomorrow(): JSONObject {
    val hwJson = JSONObject()
    try {
        val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
        val tomorrow = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, 1) }
        val tomorrowStr = sdf.format(tomorrow.time)

        val monday = Calendar.getInstance().apply {
            time = tomorrow.time
            set(Calendar.DAY_OF_WEEK, Calendar.MONDAY)
        }
        val weekStart = sdf.format(monday.time)
        val calEnd = Calendar.getInstance().apply {
            time = monday.time
            add(Calendar.DAY_OF_YEAR, 6)
        }
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

internal fun SgoClient.getQuickJson(): String {
    val dash = get(
        "student-diary/dashboard",
        mapOf("studentId" to studentId!!, "version" to "2")
    )
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

internal fun SgoClient.getDiaryJson(weekStr: String?): String {
    val monday = if (weekStr != null)
        SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).parse(weekStr)!!
    else {
        val cal = Calendar.getInstance()
        cal.set(Calendar.DAY_OF_WEEK, Calendar.MONDAY)
        cal.time
    }
    val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
    val weekStart = sdf.format(monday)
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
    return response.toString()
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