package com.example.sgodiary

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/**
 * Фоновый наблюдатель: проверяет дневник и присылает уведомления
 * о новых оценках и домашних заданиях.
 *
 * Работает как foreground-сервис, поэтому не засыпает вместе с приложением.
 * Интервал проверки и флаги уведомлений берутся из настроек интерфейса
 * (те же, что видно в разделе «Фоновый режим»), поэтому менять их можно
 * без перезапуска.
 *
 * Требования к манифесту:
 *   <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
 *   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
 *   <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
 */
class SgoWatchService : Service() {

    companion object {
        private const val TAG = "SGO_WATCH"

        const val CHANNEL_UPDATES = "sgo_updates"
        const val CHANNEL_SERVICE = "sgo_service"
        private const val FOREGROUND_ID = 1001
        private var nextNotificationId = 2000

        /** Сколько уведомлений показывать за одну проверку. */
        const val MAX_NOTIFICATIONS = 3

        const val PREFS_UI = "SgoSettingsPrefs"
        const val PREFS_LOGIN = "SgoDiaryPrefs"
        const val PREFS_WATCH = "SgoWatchPrefs"

        const val KEY_ENABLED = "sgo.backgroundEnabled"
        const val KEY_NOTIFY_MARKS = "sgo.notifyMarks"
        const val KEY_NOTIFY_HOMEWORK = "sgo.notifyHomework"
        const val KEY_INTERVAL = "sgo.backgroundInterval"
        const val KEY_STATE = "state"

        /** Включён ли фоновый режим (по умолчанию — да). */
        fun isEnabled(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS_UI, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_ENABLED, null)
            return if (raw == null) true else raw == "1"
        }

        fun setEnabled(context: Context, enabled: Boolean) {
            context.getSharedPreferences(PREFS_UI, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_ENABLED, if (enabled) "1" else "0")
                .commit()
        }

        /** Интервал проверки в минутах. */
        fun intervalMinutes(context: Context): Int {
            val prefs = context.getSharedPreferences(PREFS_UI, Context.MODE_PRIVATE)
            val value = prefs.getString(KEY_INTERVAL, "10")?.toIntOrNull() ?: 10
            return value.coerceIn(1, 240)
        }

        private fun notifyMarksEnabled(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS_UI, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_NOTIFY_MARKS, null)
            return if (raw == null) true else raw == "1"
        }

        private fun notifyHomeworkEnabled(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS_UI, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_NOTIFY_HOMEWORK, null)
            return if (raw == null) true else raw == "1"
        }

        fun start(context: Context) {
            val intent = Intent(context, SgoWatchService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Не удалось запустить фоновый сервис: ${e.message}")
            }
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, SgoWatchService::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "Не удалось остановить фоновый сервис: ${e.message}")
            }
        }
    }

    @Volatile
    private var running = false
    private var worker: Thread? = null
    private var client: SgoClient? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
        startForegroundCompat()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!running) {
            running = true
            worker = Thread({ loop() }, "sgo-watch").also { it.start() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        try { worker?.interrupt() } catch (_: Exception) { }
        worker = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // --- Фоновый цикл ---
    private fun loop() {
        while (running) {
            try {
                if (!isEnabled(applicationContext)) {
                    stopSelf()
                    return
                }
                check()
            } catch (e: Exception) {
                Log.w(TAG, "Фоновая проверка не удалась: ${e.message}")
            }

            // Ждём до следующей проверки, просыпаясь раз в полминуты:
            // так смена интервала видна почти сразу.
            var waited = 0
            val total = intervalMinutes(applicationContext) * 60
            while (running && waited < total) {
                try {
                    Thread.sleep(30_000)
                } catch (_: InterruptedException) {
                    return
                }
                waited += 30
                if (!isEnabled(applicationContext)) {
                    stopSelf()
                    return
                }
            }
        }
    }

    /** Одна проверка: забрать дневник, найти новое, показать уведомления. */
    private fun check() {
        val c = ensureClient() ?: return
        val diary = fetchDiary(c) ?: return

        val marks = mutableMapOf<String, MutableList<String>>()
        val tasks = mutableMapOf<String, MutableList<String>>()
        val markTexts = mutableMapOf<String, String>()
        val taskTexts = mutableMapOf<String, String>()

        val weekDays = diary.optJSONArray("weekDays") ?: return
        for (i in 0 until weekDays.length()) {
            val day = weekDays.getJSONObject(i)
            val dateStr = day.optString("date").take(10)
            if (dateStr.length != 10) continue
            val week = weekKey(dateStr) ?: continue

            val lessons = day.optJSONArray("lessons") ?: continue
            for (j in 0 until lessons.length()) {
                val lesson = lessons.getJSONObject(j)
                val subject = lesson.optString("subjectName")
                val number = lesson.optInt("number")
                val assigns = lesson.optJSONArray("assignments") ?: continue

                for (k in 0 until assigns.length()) {
                    val assignment = assigns.getJSONObject(k)
                    val id = assignment.optInt("id")
                    val topic = assignment.optString("assignmentName")
                    val mark = assignment.optJSONObject("mark")

                    if (mark != null && mark.has("mark")) {
                        val value = mark.optString("mark").trim()
                        if (value.isNotEmpty()) {
                            val key = "m:$id"
                            marks.getOrPut(week) { mutableListOf() }.add(key)
                            val text = buildString {
                                append(value)
                                if (subject.isNotEmpty()) append(" · $subject")
                                if (topic.isNotEmpty()) append(" — $topic")
                            }
                            markTexts[key] = text
                        }
                        continue
                    }

                    if (topic.isNotEmpty()) {
                        val key = "t|$dateStr|$number|$id"
                        tasks.getOrPut(week) { mutableListOf() }.add(key)
                        taskTexts[key] = if (subject.isNotEmpty()) "$subject: $topic" else topic
                    }
                }
            }
        }

        val state = loadState()
        val weeks = state.optJSONObject("weeks") ?: JSONObject()
        val newMarks = mutableListOf<String>()
        val newTasks = mutableListOf<String>()

        for ((week, keys) in marks) {
            if (!weeks.has(week)) continue
            val previous = weeks.getJSONObject(week).optJSONArray("marks") ?: continue
            val known = (0 until previous.length()).map { previous.getString(it) }.toSet()
            for (key in keys) if (key !in known) newMarks.add(key)
        }
        for ((week, keys) in tasks) {
            if (!weeks.has(week)) continue
            val previous = weeks.getJSONObject(week).optJSONArray("tasks") ?: continue
            val known = (0 until previous.length()).map { previous.getString(it) }.toSet()
            for (key in keys) if (key !in known) newTasks.add(key)
        }

        // Сохраняем новое состояние.
        for (week in marks.keys + tasks.keys) {
            val entry = if (weeks.has(week)) weeks.getJSONObject(week) else JSONObject()
            entry.put("marks", JSONArray(marks[week] ?: emptyList<String>()))
            entry.put("tasks", JSONArray(tasks[week] ?: emptyList<String>()))
            weeks.put(week, entry)
        }
        state.put("weeks", weeks)
        saveState(state)

        if (notifyMarksEnabled(applicationContext)) {
            newMarks.take(MAX_NOTIFICATIONS).forEach { notify("Новая оценка", markTexts[it] ?: "Новая отметка") }
        }
        if (notifyHomeworkEnabled(applicationContext)) {
            newTasks.take(MAX_NOTIFICATIONS).forEach { notify("Новое домашнее задание", taskTexts[it] ?: "Новое задание") }
        }
        val total = newMarks.size + newTasks.size
        if (total > MAX_NOTIFICATIONS) {
            notify("Дневник обновлён", "Ещё новых записей: ${total - MAX_NOTIFICATIONS}")
        }
    }

    private fun ensureClient(): SgoClient? {
        val prefs = getSharedPreferences(PREFS_LOGIN, Context.MODE_PRIVATE)
        val login = prefs.getString("login", null) ?: return null
        val pass = prefs.getString("pass", null) ?: return null
        val school = prefs.getString("school", "1244") ?: "1244"

        val existing = client
        if (existing != null && existing.isLoggedIn() && !existing.isTokenExpired()) return existing

        val fresh = SgoClient()
        if (!fresh.login(login, pass, school)) {
            Log.w(TAG, "Не удалось войти в СГО")
            return null
        }
        client = fresh
        return fresh
    }

    private fun fetchDiary(c: SgoClient): JSONObject? {
        return try {
            val cal = Calendar.getInstance().apply {
                set(Calendar.HOUR_OF_DAY, 0)
                set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
            }
            val monday = mondayOf(cal)
            val weekStart = formatDate(monday)
            val calEnd = monday.clone() as Calendar
            calEnd.add(Calendar.DAY_OF_YEAR, 13)
            val weekEnd = formatDate(calEnd)
            val student = c.studentId ?: return null
            val year = c.yearId ?: return null

            c.get(
                "student/diary",
                mapOf(
                    "studentId" to student,
                    "weekStart" to weekStart,
                    "weekEnd" to weekEnd,
                    "yearId" to year
                )
            )
        } catch (e: Exception) {
            Log.w(TAG, "Дневник не получен: ${e.message}")
            client = null // следующий раз войдём заново
            null
        }
    }

    // --- Состояние «что уже видели» ---
    private fun loadState(): JSONObject {
        val prefs = getSharedPreferences(PREFS_WATCH, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_STATE, null) ?: return JSONObject()
        return try { JSONObject(raw) } catch (e: Exception) { JSONObject() }
    }

    private fun saveState(state: JSONObject) {
        getSharedPreferences(PREFS_WATCH, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_STATE, state.toString())
            .apply()
    }

    private fun weekKey(dateStr: String): String? {
        return try {
            val date = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).parse(dateStr) ?: return null
            val cal = Calendar.getInstance().apply { time = date }
            formatDate(mondayOf(cal))
        } catch (e: Exception) {
            null
        }
    }

    private fun formatDate(cal: Calendar): String =
        SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(cal.time)

    /**
     * Понедельник недели, в которую попадает указанный момент.
     * Считаем явно через DAY_OF_WEEK + DAY_OF_YEAR: set(DAY_OF_WEEK) в разных
     * версиях Calendar ведёт себя по-разному, а от ключа недели зависит
     * и запрос дневника, и сравнение состояния.
     */
    private fun mondayOf(cal: Calendar): Calendar {
        val copy = cal.clone() as Calendar
        val offset = (copy.get(Calendar.DAY_OF_WEEK) + 5) % 7 // пн=1 -> 0, вс=7 -> 6
        copy.add(Calendar.DAY_OF_YEAR, -offset)
        return copy
    }

    // --- Уведомления ---
    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return

        val updates = NotificationChannel(
            CHANNEL_UPDATES, "Новые оценки и задания", NotificationManager.IMPORTANCE_DEFAULT
        ).apply { description = "Уведомления о новых отметках и домашних заданиях" }
        manager.createNotificationChannel(updates)

        val service = NotificationChannel(
            CHANNEL_SERVICE, "Фоновый режим", NotificationManager.IMPORTANCE_MIN
        ).apply { description = "Постоянное уведомление, пока приложение следит за дневником" }
        manager.createNotificationChannel(service)
    }

    private fun startForegroundCompat() {
        val notification = NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Дневник следит за обновлениями")
            .setContentText("Проверяем новые оценки и задания")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build()

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(FOREGROUND_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(FOREGROUND_ID, notification)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Не удалось запустить foreground-режим: ${e.message}")
        }
    }

    private fun notify(title: String, text: String) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_UPDATES)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        try {
            manager.notify(nextNotificationId++, notification)
        } catch (e: Exception) {
            Log.w(TAG, "Не удалось показать уведомление: ${e.message}")
        }
    }
}
