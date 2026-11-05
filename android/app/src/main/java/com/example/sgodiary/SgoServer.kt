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
                return newFixedLengthResponse(Response.Status.OK, "application/json",
                    "{\"ok\":true, \"authenticated\":${checkAuth()}}")
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

            val payload: String? = try {
                retryOnAuth {
                    when {
                        uri.startsWith("/api/quick") -> client.getQuickJson()
                        uri.startsWith("/api/diary") -> client.getDiaryJson(weekStart)
                        uri.startsWith("/api/schedule") -> client.getScheduleJson(weekStart)
                        uri.startsWith("/api/results") -> client.getResultsJson(termId, mode)
                        uri.startsWith("/api/grades") -> client.getGradesJson(termId)
                        uri.startsWith("/api/terms") -> client.getTermsJson()
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