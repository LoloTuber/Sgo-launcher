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
                // В отчёте StudentTotal весов нет — подтягиваем их из дневника.
                try {
                    enrichGradesWithWeights(parsed)
                } catch (e: AuthExpiredException) {
                    throw e
                } catch (e: Exception) {
                    Log.w("SGO_RESULTS", "Не удалось применить веса оценок", e)
                }
                val built = JSONObject(buildResultsFromParsed(parsed, termId, yearMode))
                // Если из отчёта не получилось ни одного числового балла —
                // считаем по данным дневника, иначе вкладка останется пустой.
                val subjects = built.optJSONArray("subjects") ?: JSONArray()
                var withAverage = false
                for (i in 0 until subjects.length()) {
                    if (!subjects.getJSONObject(i).isNull("average")) {
                        withAverage = true
                        break
                    }
                }
                if (withAverage || yearMode) return built.toString()
                lastError = "В отчёте СГО нет числовых средних"
                Log.w("SGO_RESULTS", "Отчёт без средних — считаем по дневнику")
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

/**
 * Собственное взвешенное среднее предмета и сумма весов его оценок.
 * Долг («.»/«-») считается как «2», вес берётся из отметки (её заполняет дневник).
 */
private fun subjectWeightedAverage(subject: JSONObject): Pair<Double?, Int> {
    val marks = subject.optJSONArray("marks") ?: return Pair(null, 0)
    var sum = 0.0
    var weightSum = 0
    for (j in 0 until marks.length()) {
        val mark = marks.getJSONObject(j)
        val value = markNumber(mark.optString("value")) ?: continue
        val weight = mark.optInt("weight", 1).coerceAtLeast(1)
        sum += value * weight
        weightSum += weight
    }
    return if (weightSum > 0) Pair(round2(sum / weightSum), weightSum) else Pair(null, 0)
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
        // Собственное взвешенное среднее (веса из дневника).
        val (ownAverage, ownWeight) = subjectWeightedAverage(s)
        if (final != null) finalsPresent++

        if (i == 0) {
            Log.i("SGO_RESULTS", "first '$name': termAvg=$rawTermAvg, computedAvg=$computedAvg, final=$final, marksCount=$marksCount, ownAvg=$ownAverage")
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
            if (ownAverage != null) put("weightedAverage", ownAverage)
            put("weight", ownWeight)
        })

        if (yearMode) {
            // Годовая отметка — одна оценка на предмет, вес не применим.
            if (value != null) {
                weightedSum += value
                weightTotal += 1.0
            }
        } else if (ownAverage != null) {
            weightedSum += ownAverage * ownWeight
            weightTotal += ownWeight.toDouble()
        } else if (value != null) {
            val w = marksCount.toDouble().coerceAtLeast(1.0)
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
        // Собственное взвешенное среднее и «вес» предмета.
        val (ownAverage, ownWeight) = subjectWeightedAverage(s)

        // yearMode: только те предметы, у которых есть годовая оценка.
        // currentMode: termAvg/average.
        val value = if (yearMode) final else termAvg

        out.put(JSONObject().apply {
            put("name", name)
            if (value != null) put("average", round2(value)) else put("average", JSONObject.NULL)
            if (final != null) put("final", round2(final))
            if (termAvg != null) put("termAverage", round2(termAvg))
            put("marksCount", marksCount)
            if (ownAverage != null) put("weightedAverage", ownAverage)
            put("weight", ownWeight)
        })

        if (yearMode) {
            if (value != null) {
                weightedSum += value
                weightTotal += 1.0
            }
        } else if (ownAverage != null) {
            weightedSum += ownAverage * ownWeight
            weightTotal += ownWeight.toDouble()
        } else if (value != null) {
            val w = marksCount.toDouble().coerceAtLeast(1.0)
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