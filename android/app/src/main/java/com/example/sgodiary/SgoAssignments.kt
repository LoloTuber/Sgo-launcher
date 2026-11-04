package com.example.sgodiary

import org.json.JSONArray
import org.json.JSONObject

internal fun SgoClient.getAssignmentJson(id: Int): String {
    val info = get("student/diary/assigns/$id", mapOf("studentId" to studentId!!))
    val res = JSONObject().apply { put("ok", true); put("id", id) }

    val teachers = JSONArray()
    info.optJSONArray("teachers")?.let { tArr ->
        for (i in 0 until tArr.length()) teachers.put(tArr.getJSONObject(i).optString("name"))
    }
    res.put("teachers", teachers)

    val details = JSONArray()
    if (info.has("description")) details.put(info.optString("description"))
    res.put("details", details)

    val files = JSONArray()
    info.optJSONArray("attachments")?.let { fArr ->
        for (i in 0 until fArr.length()) files.put(fArr.getJSONObject(i).optString("name"))
    }
    res.put("files", files)

    return res.toString()
}