package com.example.sgodiary

import android.util.Log
import org.json.JSONArray
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Границы учебных периодов (триместров) по их id.
 *
 * Почему это нужно: в отчёте StudentTotal СГО меняет заголовок
 * «Учебный период» по фильтру TERMID, но сами данные всегда режет по
 * фильтру «period» — интервалу дат. Поэтому при смене триместра без
 * явных дат приходили те же самые оценки текущего периода.
 *
 * Точные даты есть только у текущего периода (дашборд). Границы прошлых
 * восстанавливаем так же, как на ПК:
 * - учебный год начинается 1 сентября;
 * - конец периода = начало следующего − 1 день;
 * - внутренние границы ставим по каникулам: берём конец каникулярного
 *   блока, ближайший к середине промежутка.
 */

private val ISO_DATE = SimpleDateFormat("yyyy-MM-dd", Locale.US)

internal fun parseIsoDate(value: String?): Date? {
    if (value.isNullOrEmpty()) return null
    return try { ISO_DATE.parse(value.take(10)) } catch (e: Exception) { null }
}

internal fun formatIsoDate(date: Date): String = ISO_DATE.format(date)

internal fun addDays(date: Date, days: Int): Date {
    val cal = Calendar.getInstance()
    cal.time = date
    cal.add(Calendar.DAY_OF_MONTH, days)
    return cal.time
}

internal fun daysBetween(from: Date, to: Date): Int = ((to.time - from.time) / 86400000L).toInt()

/** Список id периодов из filterSources отчёта StudentTotal (хронологически). */
internal fun SgoClient.termIds(): List<String> {
    val ids = mutableListOf<String>()
    try {
        var res = get("reports/StudentTotal")
        var sources = res.optJSONArray("filterSources") ?: JSONArray()
        if (sources.length() == 0) {
            Thread.sleep(500)
            res = get("reports/StudentTotal")
            sources = res.optJSONArray("filterSources") ?: JSONArray()
        }
        for (i in 0 until sources.length()) {
            val src = sources.getJSONObject(i)
            if (src.optString("filterId") != "TERMID") continue
            val items = src.optJSONArray("items") ?: JSONArray()
            for (j in 0 until items.length()) {
                val value = items.getJSONObject(j).optString("value").trim()
                if (value.isEmpty() || value == "-1") continue
                ids.add(value)
            }
            break
        }
    } catch (e: AuthExpiredException) {
        throw e
    } catch (e: Exception) {
        Log.w("SGO_TERM", "Не удалось получить список периодов: ${e.message}")
    }
    return ids
}

/** Каникулярные блоки (начало, конец), сохранённые при входе. */
private fun SgoClient.vacationBlocks(): List<Pair<Date, Date>> {
    val blocks = mutableListOf<Pair<Date, Date>>()
    for ((from, to) in vacationRanges) {
        val start = parseIsoDate(from) ?: continue
        val end = parseIsoDate(to) ?: continue
        blocks.add(start to end)
    }
    blocks.sortBy { it.second }
    return blocks
}

/** Ближайший к «идеальной» границе конец каникулярного блока. */
private fun nearestVacationEnd(
    blocks: List<Pair<Date, Date>>,
    ideal: Date,
    low: Date,
    high: Date
): Date {
    var best: Date? = null
    var bestDelta = Int.MAX_VALUE
    for ((_, end) in blocks) {
        if (end.before(low) || end.after(high)) continue
        val delta = Math.abs(daysBetween(ideal, end))
        if (delta < bestDelta) {
            best = end
            bestDelta = delta
        }
    }
    return best ?: ideal
}

/**
 * Границы периодов: id → (начало, конец) в формате yyyy-MM-dd.
 * Кэшируется на 30 минут — границы меняются только вместе с учебным годом.
 */
internal fun SgoClient.termPeriodRanges(): Map<String, Pair<String, String>> {
    synchronized(termPeriodsCache) {
        val cached = termPeriodsCache["ranges"]
        if (cached != null && System.currentTimeMillis() - cached.first < TERM_PERIODS_CACHE_TTL) {
            return cached.second
        }
    }
    val ranges = buildTermPeriodRanges()
    synchronized(termPeriodsCache) {
        termPeriodsCache["ranges"] = Pair(System.currentTimeMillis(), ranges)
    }
    return ranges
}

private fun SgoClient.buildTermPeriodRanges(): Map<String, Pair<String, String>> {
    val result = mutableMapOf<String, Pair<String, String>>()
    val currentStart = parseIsoDate(termStart) ?: return result
    val currentEnd = parseIsoDate(termEnd) ?: currentStart
    if (currentTermId.isNotEmpty()) {
        result[currentTermId] = formatIsoDate(currentStart) to formatIsoDate(currentEnd)
    }

    val ids = termIds()
    if (ids.isEmpty()) return result
    val idx = ids.indexOf(currentTermId).let { if (it < 0) ids.size - 1 else it }
    val past = ids.subList(0, idx)
    if (past.isEmpty()) return result

    // Учебный год начинается 1 сентября.
    val cal = Calendar.getInstance().apply { time = currentStart }
    val month = cal.get(Calendar.MONTH) + 1
    val schoolYear = if (month >= 9) cal.get(Calendar.YEAR) else cal.get(Calendar.YEAR) - 1
    val spanStart = parseIsoDate("$schoolYear-09-01") ?: return result
    val spanEnd = addDays(currentStart, -1)
    val blocks = vacationBlocks()

    if (past.size == 1) {
        result[past[0]] = formatIsoDate(spanStart) to formatIsoDate(spanEnd)
        return result
    }

    val days = daysBetween(spanStart, spanEnd) + 1
    val boundaries = mutableListOf<Date>()
    for (k in 1 until past.size) {
        val ideal = addDays(spanStart, Math.round(days.toDouble() * k / past.size).toInt())
        boundaries.add(nearestVacationEnd(blocks, ideal, spanStart, spanEnd))
    }
    var previous = spanStart
    for (i in past.indices) {
        var end = if (i < boundaries.size) boundaries[i] else spanEnd
        if (end.before(previous)) end = previous
        result[past[i]] = formatIsoDate(previous) to formatIsoDate(end)
        previous = addDays(end, 1)
    }
    return result
}

/** Значение фильтра «period» для СГО в формате отчёта. */
internal fun SgoClient.periodFilterValue(termId: String?): String {
    if (termId.isNullOrEmpty()) return ""
    val period = termPeriodRanges()[termId] ?: return ""
    return "${period.first}T00:00:00.0000000 - ${period.second}T00:00:00.0000000"
}
