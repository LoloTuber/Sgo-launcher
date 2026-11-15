package com.example.sgodiary

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Запускает фонового наблюдателя после перезагрузки телефона —
 * чтобы приложение снова следило за дневником, даже если его не открывали.
 *
 * Запускается только если фоновый режим включён в настройках.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        try {
            if (SgoWatchService.isEnabled(context)) {
                SgoWatchService.start(context)
                Log.i("SGO_WATCH", "Фоновый режим запущен после перезагрузки")
            }
        } catch (e: Exception) {
            Log.w("SGO_WATCH", "Не удалось запустить фоновый режим: ${e.message}")
        }
    }
}
