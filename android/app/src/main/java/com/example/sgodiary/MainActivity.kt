package com.example.sgodiary

import android.annotation.SuppressLint
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import java.io.IOException

class ClipboardBridge(private val context: Context) {
    @JavascriptInterface
    fun getText(): String {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = cm.primaryClip ?: return ""
        if (clip.itemCount == 0) return ""
        return clip.getItemAt(0).coerceToText(context)?.toString() ?: ""
    }
}

/**
 * Настройки интерфейса (тёмная тема, цветовая палитра, фоновый режим).
 * Хранится в SharedPreferences — переживает перезапуск процесса,
 * переустановку WebView и смену порта. Отдельный файл prefs,
 * чтобы не пересекаться с логином/паролем (SgoDiaryPrefs).
 */
class SettingsBridge(private val context: Context) {
    private val prefs = context.getSharedPreferences("SgoSettingsPrefs", Context.MODE_PRIVATE)

    @JavascriptInterface
    fun get(key: String): String? = prefs.getString(key, null)

    @JavascriptInterface
    fun set(key: String, value: String) {
        // commit() — синхронно, чтобы значение точно записалось до закрытия приложения.
        prefs.edit().putString(key, value).commit()
        // Фоновый режим: сервис запускаем/останавливаем сразу,
        // чтобы переключение в настройках работало без перезапуска.
        if (key == SgoWatchService.KEY_ENABLED) {
            if (value == "1") SgoWatchService.start(context) else SgoWatchService.stop(context)
        }
    }

    @JavascriptInterface
    fun remove(key: String) {
        prefs.edit().remove(key).commit()
    }
}

class MainActivity : AppCompatActivity() {
    private var server: SgoServer? = null
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
        }

        webView.webViewClient = WebViewClient()
        webView.webChromeClient = WebChromeClient()

        // ВАЖНО: мосты регистрируются ДО loadUrl — иначе JS их не увидит.
        webView.addJavascriptInterface(ClipboardBridge(this), "AndroidClipboard")
        webView.addJavascriptInterface(SettingsBridge(this), "AndroidSettings")

        server = SgoServer(applicationContext)
        try {
            server?.start()
        } catch (e: IOException) {
            e.printStackTrace()
        }

        // Фоновый режим: сервис следит за дневником, пока приложение закрыто.
        if (SgoWatchService.isEnabled(this)) {
            SgoWatchService.start(this)
        }
        requestNotificationPermission()

        webView.loadUrl("http://127.0.0.1:8080/")
    }

    /**
     * Android 13+ требует отдельного разрешения на уведомления.
     * Без него фоновая проверка всё равно работает, но сообщения не покажутся.
     */
    private fun requestNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) return
        try {
            val granted = checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!granted) {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (webView.canGoBack()) {
                webView.goBack()
                return true
            }
            webView.evaluateJavascript("if(window.switchToHomeTab){window.switchToHomeTab();}", null)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        server?.stop()
        webView.destroy()
        super.onDestroy()
    }
}