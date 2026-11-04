package com.example.sgodiary

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

internal fun SgoClient.fetchWeightEntries(start: String, end: String): List<WeightEntry> {
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
                entries.add(WeightEntry(
                    subject = subject,
                    date = date,
                    value = value,
                    info = MarkWeight(
                        weight = assignment.optInt("weight", 1).coerceAtLeast(1),
                        id = assignment.optInt("id", 0),
                        type = assignment.optString("typeName")
                    )
                ))
            }
        }
    }

    synchronized(weightsCache) {
        if (weightsCache.size > 8) weightsCache.clear()
        weightsCache[cacheKey] = entries
    }
    return entries
}

internal fun SgoClient.takeMarkWeight(
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

internal fun SgoClient.enrichGradesWithWeights(grades: JSONObject) {
    val days = grades.optJSONArray("days") ?: JSONArray()
    var start = ""; var end = ""
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
                index, subjectName,
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