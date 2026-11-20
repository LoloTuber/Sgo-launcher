package com.example.sgodiary

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class SgoServer(private val context: Context) : NanoHTTPD(8080) {
    private val client = SgoClient()
    private val prefs = context.getSharedPreferences("SgoDiaryPrefs", Context.MODE_PRIVATE)
    private val autoLoginDone = CountDownLatch(1)

    init {
        val savedLogin = prefs.getString("login", null)
        val savedPass = prefs.getString("pass", null)
        val savedSchool = prefs.getString("school", "1244")

        if (savedLogin != null && savedPass != null) {
            Thread {
                try {
                    Log.i("SGO_SERVER", "Автовход для $savedLogin...")
                    client.login(savedLogin, savedPass, savedSchool!!)
                } finally {
                    autoLoginDone.countDown()
                }
            }.start()
        } else {
            autoLoginDone.countDown()
        }
    }

    private fun relogin(): Boolean {
        val savedLogin = prefs.getString("login", null) ?: return false
        val savedPass = prefs.getString("pass", null) ?: return false
        val savedSchool = prefs.getString("school", "1244") ?: "1244"
        val ok = client.login(savedLogin, savedPass, savedSchool)
        Log.i("SGO_SERVER", "Повторный вход: $ok")
        return ok
    }

    @Synchronized
    private fun checkAuth(): Boolean {
        if (!client.isLoggedIn()) {
            try {
                autoLoginDone.await(25, TimeUnit.SECONDS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        if (!client.isLoggedIn() || client.isTokenExpired()) {
            relogin()
        }
        return client.isLoggedIn() && !client.isTokenExpired()
    }

    private inline fun <T> retryOnAuth(block: () -> T): T {
        return try {
            block()
        } catch (e: AuthExpiredException) {
            Log.i("SGO_SERVER", "Сессия истекла во время запроса, повторный вход")
            if (!relogin()) throw e
            block()
        }
    }

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method

        // Log.i (не Log.d) — чтобы запросы были видны в стандартном фильтре logcat.
        Log.i("SGO_SERVER", "Запрос: $method $uri params=${session.parameters}")

        if (uri.startsWith("/api/")) {
            if (uri == "/api/refresh" && method == Method.POST) {
                client.reset()
                relogin()
                return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}")
            }

            if (uri == "/api/check_auth") {
                val school = prefs.getString("school", "") ?: ""
                return newFixedLengthResponse(Response.Status.OK, "application/json",
                    "{\"ok\":true, \"authenticated\":${checkAuth()}, \"school\":\"$school\"}")
            }

            if (uri == "/api/logout" && method == Method.POST) {
                prefs.edit().remove("login").remove("pass").remove("school").commit()
                client.reset()
                Log.i("SGO_SERVER", "Пользователь вышел из аккаунта")
                return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}")
            }

            if (uri == "/api/login" && method == Method.POST) {
                try {
                    val contentLength = session.headers["content-length"]?.toIntOrNull() ?: 0
                    val buffer = ByteArray(contentLength)
                    var readTotal = 0
                    while (readTotal < contentLength) {
                        val n = session.inputStream.read(buffer, readTotal, contentLength - readTotal)
                        if (n <= 0) break
                        readTotal += n
                    }
                    val postData = String(buffer, 0, readTotal, Charsets.UTF_8)

                    val json = JSONObject(postData)
                    val loginStr = json.getString("login")
                    val passStr = json.getString("pass")
                    val schoolStr = json.optString("school", "1244")

                    val success = client.login(loginStr, passStr, schoolStr)

                    if (success) {
                        prefs.edit()
                            .putString("login", loginStr)
                            .putString("pass", passStr)
                            .putString("school", schoolStr)
                            .apply()
                        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}")
                    } else {
                        val fail = JSONObject().apply {
                            put("ok", false)
                            put("error", "Неверный логин или пароль")
                            put("login", loginStr)
                            put("passLen", passStr.length)
                        }
                        return newFixedLengthResponse(Response.Status.UNAUTHORIZED, "application/json", fail.toString())
                    }
                } catch (e: Exception) {
                    return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                        "{\"ok\":false, \"error\":\"Ошибка сервера: ${e.message}\"}")
                }
            }

            if (!checkAuth()) {
                return newFixedLengthResponse(Response.Status.UNAUTHORIZED, "application/json",
                    "{\"ok\":false, \"error\":\"Не авторизован\"}")
            }

            val query = session.parameters
            val weekStart = query["week"]?.firstOrNull()
            val termId = query["term"]?.firstOrNull()
            val mode = query["mode"]?.firstOrNull() ?: "current"
            // refresh=1 — читать неделю заново, а не отдавать предзагруженную копию.
            val refreshRaw = query["refresh"]?.firstOrNull()?.lowercase()
            val forceDiary = refreshRaw == "1" || refreshRaw == "true" || refreshRaw == "yes"

            // Сведения о сборке — для служебного режима в настройках.
            if (uri == "/api/about") {
                val about = JSONObject().apply {
                    put("ok", true)
                    put("version", APP_VERSION)
                    put("build", APP_BUILD)
                    put("platform", "android")
                    put("dataDir", context.applicationInfo.dataDir)
                    put("school", prefs.getString("school", "") ?: "")
                }
                return newFixedLengthResponse(Response.Status.OK, "application/json", about.toString())
            }

            val payload: String? = try {
                retryOnAuth {
                    when {
                        uri.startsWith("/api/quick") -> client.getQuickJson()
                        uri.startsWith("/api/diary/preload") -> {
                            // Предзагрузка соседних недель: отвечаем сразу,
                            // сами данные клиент кладёт в кэш в фоне.
                            val weeks = query["weeks"]?.firstOrNull()?.toIntOrNull() ?: 2
                            client.preloadDiary(weeks.coerceIn(1, 4))
                            JSONObject().put("ok", true).put("started", true).toString()
                        }
                        uri.startsWith("/api/diary") -> client.getDiaryJson(weekStart, forceDiary)
                        uri.startsWith("/api/schedule") -> client.getScheduleJson(weekStart)
                        uri.startsWith("/api/results") -> client.getResultsJson(termId, mode)
                        uri.startsWith("/api/grades") -> client.getGradesJson(termId)
                        uri.startsWith("/api/terms") -> client.getTermsJson()
                        uri.startsWith("/api/assignment/preload") -> {
                            // Заранее грузим подробности заданий — отвечаем сразу.
                            val ids = query["ids"]?.firstOrNull()
                                ?.split(",")
                                ?.mapNotNull { it.trim().toIntOrNull() }
                                ?: emptyList()
                            client.preloadAssignments(ids)
                            JSONObject().put("ok", true)
                                .put("started", ids.isNotEmpty())
                                .put("count", ids.size)
                                .toString()
                        }
                        uri.startsWith("/api/assignment/") -> {
                            val id = uri.substringAfterLast("/").toIntOrNull() ?: 0
                            client.getAssignmentJson(id)
                        }
                        else -> null
                    }
                }
            } catch (e: AuthExpiredException) {
                return newFixedLengthResponse(Response.Status.UNAUTHORIZED, "application/json",
                    "{\"ok\":false, \"error\":\"Сессия истекла, войдите заново\"}")
            } catch (e: Exception) {
                Log.w("SGO_SERVER", "Ошибка запроса $uri: ${e.message}", e)
                return newFixedLengthResponse(
                    Response.Status.INTERNAL_ERROR,
                    "application/json",
                    JSONObject().put("ok", false).put("error", e.message ?: "Ошибка сервера").toString()
                )
            }

            if (payload == null) {
                return newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json", "{\"ok\":false}")
            }
            Log.i("SGO_SERVER", "Ответ $uri: ${payload.length} байт")
            return newFixedLengthResponse(Response.Status.OK, "application/json", payload)
        }

        val path = if (uri == "/") "/index.html" else uri
        return try {
            val inputStream = context.assets.open("web$path")
            val mime = when {
                path.endsWith(".js") -> "application/javascript"
                path.endsWith(".css") -> "text/css"
                path.endsWith(".json") -> "application/json"
                else -> "text/html"
            }
            newChunkedResponse(Response.Status.OK, mime, inputStream)
        } catch (e: IOException) {
            newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Файл не найден: $path")
        }
    }
}