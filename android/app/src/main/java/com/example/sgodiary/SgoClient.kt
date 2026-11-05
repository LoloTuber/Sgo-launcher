package com.example.sgodiary

import android.util.Base64
import android.util.Log
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.Charset
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class SimpleCookieJar : CookieJar {
    private val cookieStore = mutableMapOf<String, List<Cookie>>()
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) { cookieStore[url.host] = cookies }
    override fun loadForRequest(url: HttpUrl): List<Cookie> = cookieStore[url.host] ?: emptyList()
}

class AuthExpiredException : Exception("AUTH_EXPIRED")

/**
 * Транспорт для СГО. Все бизнес-методы (getGradesJson, getTermsJson, parseReportHtml
 * и т.д.) живут в отдельных файлах как extension-функции:
 *   SgoDiary.kt        — getQuickJson, getDiaryJson, getScheduleJson, getHomeworkForTomorrow
 *   SgoGrades.kt       — getGradesJson, getGradesJsonFallback
 *   SgoResults.kt      — getResultsJson
 *   SgoTerms.kt        — getTermsJson (с фильтром «только до текущего»)
 *   SgoReports.kt      — getStudentTotalHtml, parseReportHtml
 *   SgoWeights.kt      — fetchWeightEntries, takeMarkWeight, enrichGradesWithWeights
 *   SgoAssignments.kt  — getAssignmentJson
 *   SgoUtils.kt        — константы, round2, нормализация
 *
 * Здесь — только login, HTTP-обвязка, токен и кэш весов.
 */
class SgoClient {
    private val cookieJar = SimpleCookieJar()
    private val logging = HttpLoggingInterceptor { message -> Log.d("SGO_HTTP", message) }
        .apply { level = HttpLoggingInterceptor.Level.BODY }

    internal val client = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .addInterceptor(logging)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    internal val wsClient = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    internal val baseUrl = "https://sgo.volganet.ru/webapi/"

    internal var token: String? = null
    internal var tokenExpiresAt: Long = 0
    internal var studentId: String? = null
    internal var yearId: String? = null
    internal var studentName: String = ""
    internal var termName: String = ""
    internal var termStart: String = ""
    internal var termEnd: String = ""
    internal var currentTermId: String = ""
    internal var organizationName: String = ""

    // Кэш весов оценок: заполняется в SgoWeights.kt, читается оттуда же.
    internal val weightsCache = mutableMapOf<String, List<WeightEntry>>()

    fun isLoggedIn() = token != null

    fun reset() {
        token = null
        tokenExpiresAt = 0
        synchronized(weightsCache) { weightsCache.clear() }
    }

    fun isTokenExpired(): Boolean {
        if (token == null) return true
        return tokenExpiresAt > 0 && System.currentTimeMillis() / 1000 >= tokenExpiresAt - 60
    }

    private fun parseTokenExpiry(jwt: String): Long {
        return try {
            val payload = jwt.split(".").getOrNull(1) ?: return 0
            val bytes = Base64.decode(payload, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            JSONObject(String(bytes, Charsets.UTF_8)).optLong("exp", 0)
        } catch (e: Exception) {
            0
        }
    }

    internal fun getBuilder(url: String): Request.Builder {
        return Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            .header("Referer", "https://sgo.volganet.ru/")
            .header("Accept", "application/json, text/plain, */*")
    }

    private fun toHex(bytes: ByteArray): String {
        val hexChars = "0123456789abcdef"
        val result = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val i = b.toInt() and 0xff
            result.append(hexChars[i ushr 4]).append(hexChars[i and 0x0f])
        }
        return result.toString()
    }

    @Synchronized
    fun login(loginStr: String, passStr: String, schoolId: String = "1244"): Boolean {
        try {
            client.newCall(getBuilder(baseUrl + "logindata").build()).execute().close()
            val metaReq = getBuilder(baseUrl + "auth/getdata")
                .post("".toRequestBody("text/plain".toMediaType())).build()
            val metaRes = client.newCall(metaReq).execute()
            val metaBody = metaRes.body?.string() ?: "{}"
            val metaJson = JSONObject(metaBody)
            val salt = metaJson.optString("salt")
            Log.i("SGO_LOGIN", "getdata: http=${metaRes.code}, salt='$salt'")
            if (salt.isEmpty()) return false

            val md5 = MessageDigest.getInstance("MD5")
            val pw2 = toHex(md5.digest(passStr.toByteArray(Charset.forName("windows-1251"))))
            val finalPw2 = toHex(md5.digest((salt + pw2).toByteArray(Charsets.UTF_8)))
            val pw = finalPw2.substring(0, passStr.length)

            val formBuilder = FormBody.Builder()
                .add("loginType", "1").add("scid", schoolId)
                .add("un", loginStr).add("pw", pw).add("pw2", finalPw2)

            val keys = metaJson.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (key != "salt") formBuilder.add(key, metaJson.optString(key))
            }

            Log.i("SGO_LOGIN", "Отправка формы: un='$loginStr' (len=${loginStr.length}), passLen=${passStr.length}")
            val loginRes = client.newCall(getBuilder(baseUrl + "login").post(formBuilder.build()).build()).execute()
            val loginBody = loginRes.body?.string() ?: ""
            Log.i("SGO_LOGIN", "Ответ от СГО: http=${loginRes.code}")

            val loginJson = JSONObject(loginBody)
            val at = loginJson.optString("at")
            if (at.isEmpty()) return false
            token = at
            val jwt = loginJson.optString("accessToken")
            tokenExpiresAt = if (jwt.isNotEmpty()) parseTokenExpiry(jwt) else 0
            Log.i("SGO_LOGIN", "Токен получен, истекает через ${tokenExpiresAt - System.currentTimeMillis() / 1000} c")

            val initData = get("student/diary/init")
            val students = initData.optJSONArray("students") ?: JSONArray()
            if (students.length() == 0) return false

            val currentIdx = initData.optInt("currentStudentId", 0)
            val student = students.getJSONObject(if (currentIdx < students.length()) currentIdx else 0)
            studentId = student.optString("studentId")
            studentName = student.optString("nickName", student.optString("fullName", "Ученик"))

            val yearData = get("years/current", mapOf("studentId" to studentId!!))
            yearId = yearData.optString("id")

            val contextObj = get("context")
            organizationName = contextObj.optString("organizationName")

            val dash = get("student-diary/dashboard", mapOf("studentId" to studentId!!, "version" to "2"))
            termName = dash.optString("termName")
            termStart = dash.optString("termStartDate")
            termEnd = dash.optString("termEndDate")
            currentTermId = dash.optString("termId")

            return true
        } catch (e: Exception) {
            Log.e("SGO", "Ошибка login", e)
            return false
        }
    }

    internal fun get(path: String, params: Map<String, String>? = null): JSONObject {
        val urlBuilder = (baseUrl + path).toHttpUrlOrNull()?.newBuilder()
        if (params != null && urlBuilder != null) {
            for ((k, v) in params) urlBuilder.addQueryParameter(k, v)
        }
        val req = getBuilder(urlBuilder!!.build().toString()).header("at", token ?: "").build()
        val res = client.newCall(req).execute()
        if (res.code == 401 || res.code == 403) {
            res.close()
            token = null
            tokenExpiresAt = 0
            Log.i("SGO_LOGIN", "Сессия истекла (HTTP ${res.code}) для $path")
            throw AuthExpiredException()
        }
        return try { JSONObject(res.body?.string() ?: "{}") } catch (e: Exception) { JSONObject() }
    }
}