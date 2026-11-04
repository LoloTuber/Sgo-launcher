package com.example.sgodiary

import java.util.Locale
import kotlin.math.roundToInt

// ---------- Константы ----------
internal val WEEKDAYS = arrayOf(
    "воскресенье", "понедельник", "вторник", "среда",
    "четверг", "пятница", "суббота"
)

internal val MONTHS = arrayOf(
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"
)

internal val MONTHS_MAP = mapOf(
    "январь" to 1, "февраль" to 2, "март" to 3, "апрель" to 4, "май" to 5, "июнь" to 6,
    "июль" to 7, "август" to 8, "сентябрь" to 9, "октябрь" to 10, "ноябрь" to 11, "декабрь" to 12
)

internal val ATTENDANCE_CODES = mapOf(
    "Н" to "не был",
    "НП" to "пропуск по неуважительной причине",
    "УП" to "пропуск по уважительной причине",
    "Б" to "пропустил по болезни",
    "ОТ" to "отсутствовал",
    "ОП" to "опоздал",
    "ОСВ" to "освобождён от посещения"
)

internal val NOT_ABSENCE_CODES = setOf("ОСВ", "ОП")

// «Точка» (долг/невыставленная оценка) — показываем, но в среднее не включаем.
internal const val DOT_MARK = "."
internal const val DASH_MARK = "-"

// ---------- Data-классы весов ----------
internal data class MarkWeight(val weight: Int, val id: Int, val type: String)
internal data class WeightEntry(
    val subject: String,
    val date: String,
    val value: String,
    val info: MarkWeight
)

// ---------- Утилиты ----------
internal fun round2(value: Double): Double = (value * 100.0).roundToInt() / 100.0

internal fun normalizeSubjectName(name: String): String =
    name.lowercase(Locale.getDefault())
        .replace('ё', 'е')
        .replace(Regex("\\s+"), " ")
        .trim()

/** "5", "5.0", "5,0" -> "5" — единый вид для сопоставления. */
internal fun normalizeMarkValue(value: String): String {
    val normalized = value.trim().replace(',', '.')
    val number = normalized.toDoubleOrNull() ?: return normalized
    return if (number % 1.0 == 0.0) number.toInt().toString() else normalized
}

internal fun weightKey(subject: String, date: String, value: String) = "$subject|$date|$value"