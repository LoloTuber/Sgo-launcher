package com.example.sgodiary

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

internal fun SgoClient.getResultsJson(termId: String?, mode: String): String {
    val yearMode = mode == "year"
    var lastError: String? = null

    val html = try {
        getStudentTotalHtml(termId)
    } catch (e: AuthExpiredException) {
        throw e
    } catch (e: Exception) {
        Log.w("SGO_RESULTS", "getStudentTotalHtml упал", e)
        lastError = e.message
        null
    }

    Log.i("SGO_RESULTS", "getResultsJson: termId=$termId, mode=$mode, html=${html?.let { "ok(${it.length})" } ?: "null"}")

    if (html != null) {
        try {
            val parsed = JSONObject(parseReportHtml(html))
            if (parsed.optBoolean("ok", false)) {
                return buildResultsFromParsed(parsed, termId, yearMode)
            } else {
                lastError = parsed.optString("error", "Отчёт не разобран")
            }
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            Log.w("SGO_RESULTS", "parseReportHtml failed", e)
            lastError = e.message
        }
    }

    return try {
        val fallbackJson = JSONObject(getGradesJson(termId))
        buildResultsFromGrades(
            fallbackJson, termId, yearMode,
            "Не удалось получить отчёт за выбранный период: ${lastError ?: "неизвестная ошибка"}. Показаны приблизительные данные."
        )
    } catch (e: AuthExpiredException) {
        throw e
    } catch (e: Exception) {
        JSONObject().apply {
            put("ok", false)
            put("error", "Итоги недоступны: ${e.message}")
            put("requestedTermId", termId ?: "")
            put("mode", mode)
        }.toString()
    }
}

private fun SgoClient.buildResultsFromParsed(
    parsed: JSONObject,
    requestedTermId: String?,
    yearMode: Boolean
): String {
    val subjectsArr = parsed.optJSONArray("subjects") ?: JSONArray()
    val out = JSONArray()
    var weightedSum = 0.0
    var weightTotal = 0.0
    var finalsPresent = 0

    for (i in 0 until subjectsArr.length()) {
        val s = subjectsArr.getJSONObject(i)
        val name = s.optString("name").trim()
        if (name.isEmpty()) continue

        val rawTermAvg = s.optString("termAverage").replace(',', '.').toDoubleOrNull()
        val computedAvg = s.optDouble("average", Double.NaN).takeIf { !it.isNaN() && it > 0 }
        val termAvg = rawTermAvg ?: computedAvg
        val final = s.optString("final").replace(',', '.').toDoubleOrNull()
        val marksCount = s.optInt("marksCount", s.optInt("count", 0))
        if (final != null) finalsPresent++

        if (i == 0) {
            Log.i("SGO_RESULTS", "first '$name': termAvg=$rawTermAvg, computedAvg=$computedAvg, final=$final, marksCount=$marksCount")
        }

        // yearMode: показываем только если в отчёте есть year-колонка.
        // currentMode: termAvg (из отчёта) или computedAvg (из marks).
        val value = if (yearMode) final else termAvg
        out.put(JSONObject().apply {
            put("name", name)
            if (value != null) put("average", round2(value)) else put("average", JSONObject.NULL)
            if (final != null) put("final", round2(final))
            if (termAvg != null) put("termAverage", round2(termAvg))
            put("marksCount", marksCount)
        })

        if (value != null) {
            val w = if (yearMode) 1.0 else marksCount.toDouble().coerceAtLeast(1.0)
            weightedSum += value * w
            weightTotal += w
        }
    }

    val common = if (weightTotal > 0) round2(weightedSum / weightTotal) else null
    val reportTerm = parsed.optString("term").ifEmpty { termName }

    val result = JSONObject().apply {
        put("ok", true)
        if (common != null) put("common", common) else put("common", JSONObject.NULL)
        put("subjects", out)
        put("term", reportTerm)
        put("mode", if (yearMode) "year" else "current")
        put("finalAvailable", finalsPresent > 0)
        put("asOf", parsed.optString("asOf"))
        put("requestedTermId", requestedTermId ?: "")
    }

    Log.i("SGO_RESULTS", "buildFromParsed: mode=${if (yearMode) "year" else "current"}, out=${out.length()}/${subjectsArr.length()}, finals=$finalsPresent")
    return result.toString()
}

private fun SgoClient.buildResultsFromGrades(
    grades: JSONObject,
    requestedTermId: String?,
    yearMode: Boolean,
    error: String?
): String {
    val subs = grades.optJSONArray("subjects") ?: JSONArray()
    val out = JSONArray()
    var weightedSum = 0.0
    var weightTotal = 0.0

    for (i in 0 until subs.length()) {
        val s = subs.getJSONObject(i)
        val name = s.optString("name").trim()
        if (name.isEmpty()) continue

        // termAverage (из отчёта) → average (посчитанный из marks).
        val termAvg = s.optString("termAverage").replace(',', '.').toDoubleOrNull()
            ?: s.optDouble("average", Double.NaN).takeIf { !it.isNaN() && it > 0 }
        val final = s.optString("final").replace(',', '.').toDoubleOrNull()
        val marksCount = s.optInt("marksCount", s.optInt("count", 0))

        // yearMode: только те предметы, у которых есть годовая оценка.
        // currentMode: termAvg/average.
        val value = if (yearMode) final else termAvg

        out.put(JSONObject().apply {
            put("name", name)
            if (value != null) put("average", round2(value)) else put("average", JSONObject.NULL)
            if (final != null) put("final", round2(final))
            if (termAvg != null) put("termAverage", round2(termAvg))
            put("marksCount", marksCount)
        })

        if (value != null) {
            val w = if (yearMode) 1.0 else marksCount.toDouble().coerceAtLeast(1.0)
            weightedSum += value * w
            weightTotal += w
        }
    }

    Log.i("SGO_RESULTS", "buildFromGrades: mode=${if (yearMode) "year" else "current"}, out=${out.length()}/${subs.length()}")

    return JSONObject().apply {
        put("ok", true)
        if (weightTotal > 0) put("common", round2(weightedSum / weightTotal))
        else put("common", JSONObject.NULL)
        put("subjects", out)
        put("term", grades.optString("term").ifEmpty { termName })
        put("mode", if (yearMode) "year" else "current")
        put("finalAvailable", false)
        put("asOf", grades.optString("asOf"))
        put("requestedTermId", requestedTermId ?: "")
        if (error != null) put("error", error)
    }.toString()
}