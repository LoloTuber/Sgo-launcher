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
 * Настройки интерфейса (тёмная тема, цветовая палитра).
 * Хранится в SharedPreferences — переживает перезапуск процесса,
 * переустановку WebView и смену порта. Отдельный файл prefs,
 * чтобы не пересекаться с логином/паролем (SgoDiaryPrefs).
 */
class SettingsBridge(context: Context) {
    private val prefs = context.getSharedPreferences("SgoSettingsPrefs", Context.MODE_PRIVATE)

    @JavascriptInterface
    fun get(key: String): String? = prefs.getString(key, null)

    @JavascriptInterface
    fun set(key: String, value: String) {
        // commit() — синхронно, чтобы значение точно записалось до закрытия приложения.
        prefs.edit().putString(key, value).commit()
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

        webView.loadUrl("http://127.0.0.1:8080/")
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