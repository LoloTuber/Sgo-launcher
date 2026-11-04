package com.example.sgodiary

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

internal fun SgoClient.getTermsJson(): String {
    val arr = JSONArray()
    var gotRealTerms = false

    try {
        var res = get("reports/StudentTotal")
        var sources = res.optJSONArray("filterSources") ?: JSONArray()
        Log.i("SGO_TERMS", "filterSources=${sources.length()}")

        // SGO иногда возвращает {} сразу после логина — retry через 500 мс.
        if (sources.length() == 0) {
            Thread.sleep(500)
            res = get("reports/StudentTotal")
            sources = res.optJSONArray("filterSources") ?: JSONArray()
            Log.i("SGO_TERMS", "retry filterSources=${sources.length()}")
        }

        for (i in 0 until sources.length()) {
            val src = sources.getJSONObject(i)
            if (src.optString("filterId") != "TERMID") continue
            val items = src.optJSONArray("items")
            Log.i("SGO_TERMS", "TERMID items=${items?.length() ?: 0}")
            if (items != null && items.length() > 0) {
                for (j in 0 until items.length()) {
                    val item = items.getJSONObject(j)
                    val value = item.optString("value")
                    val title = item.optString("title")
                    Log.i("SGO_TERMS", "  [$j] value='$value', title='$title'")
                    if (value.isNotEmpty()) {
                        arr.put(JSONObject().apply {
                            put("id", value)
                            put("name", title.ifEmpty { "Период $value" })
                        })
                        gotRealTerms = true
                    }
                }
            } else {
                val def = src.optString("defaultValue")
                Log.w("SGO_TERMS", "TERMID items empty, defaultValue='$def'")
                if (def.isNotEmpty()) {
                    arr.put(JSONObject().apply {
                        put("id", def)
                        put("name", termName.ifEmpty { "Текущий период" })
                    })
                    gotRealTerms = true
                }
            }
        }
    } catch (e: AuthExpiredException) {
        throw e
    } catch (e: Exception) {
        Log.e("SGO_TERMS", "reports/StudentTotal failed", e)
    }

    if (!gotRealTerms) {
        Log.w("SGO_TERMS", "Fallback: currentTermId='$currentTermId', termName='$termName'")
        when {
            currentTermId.isNotEmpty() ->
                arr.put(JSONObject().apply {
                    put("id", currentTermId)
                    put("name", termName.ifEmpty { "Текущий период" })
                })
            termName.isNotEmpty() ->
                arr.put(JSONObject().apply {
                    put("id", "current")
                    put("name", termName)
                })
            else ->
                arr.put(JSONObject().apply {
                    put("id", "current")
                    put("name", "Текущий период")
                })
        }
        return JSONObject().put("ok", true).put("terms", arr).toString()
    }

    // ── ФИЛЬТР ────────────────────────────────────────────────────────────
    // Оставляем только триместры до текущего включительно.
    // Будущие триместры (2, 3 при текущем 1-м) не показываем: СГО для них
    // не умеет строить отчёт (queue: taskId=-1), а fallback getGradesJsonFallback
    // подставляет данные ТЕКУЩЕГО триместра — из-за этого кажется, что
    // «несуществующий триместр отображается».
    val filtered = JSONArray()
    var cutoff = false

    for (i in 0 until arr.length()) {
        val item = arr.getJSONObject(i)
        val id = item.optString("id")

        // «-1 — Произвольный интервал» — не триместр, убираем всегда.
        if (id == "-1") continue

        filtered.put(item)

        if (currentTermId.isNotEmpty() && id == currentTermId) {
            cutoff = true
            Log.i("SGO_TERMS", "Cutoff at currentTermId='$id'")
            break
        }
    }

    // Если currentTermId не встретился в списке — фильтр не сработал,
    // показываем всё (без -1).
    val finalArr = if (!cutoff && currentTermId.isNotEmpty()) {
        val safe = JSONArray()
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            if (item.optString("id") != "-1") safe.put(item)
        }
        Log.w("SGO_TERMS", "currentTermId='$currentTermId' not in list; showing all")
        safe
    } else {
        filtered
    }

    val result = JSONObject().put("ok", true).put("terms", finalArr).toString()
    Log.i("SGO_TERMS", "Result: $result")
    return result
}