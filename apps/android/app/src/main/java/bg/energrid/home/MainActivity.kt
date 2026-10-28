package bg.energrid.home

import android.annotation.SuppressLint
import android.Manifest
import android.content.pm.PackageManager
import android.content.pm.ActivityInfo
import android.content.Intent
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.widget.Toast
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.CookieManager
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.PermissionRequest
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var wakeWordController: WakeWordController
    private val preferences by lazy { getSharedPreferences("wake-word", MODE_PRIVATE) }
    private val notificationPreferences by lazy { getSharedPreferences("energrid-notifications", MODE_PRIVATE) }
    private var pageReady = false
    private var appVisible = false
    private var pendingWebPermissionRequest: PermissionRequest? = null
    private var pendingManualPermission = false

    companion object {
        private const val TAG = "EnergridKiosk"
        private const val REQUEST_MICROPHONE = 4102
        private const val REQUEST_NOTIFICATIONS = 4103
        private const val REQUEST_NOTIFICATIONS_STARTUP = 4104
        private const val NOTIFICATION_CHANNEL_ID = "energrid_dashboard_alerts"
        private const val PREF_WAKE_ENABLED = "enabled"
        private const val NOTIFICATION_IDS_KEY = "native_notification_ids"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUI()
        createNotificationChannel()

        wakeWordController = WakeWordController(this, object : WakeWordController.Listener {
            override fun onStatus(status: String) {
                runOnUiThread { publishWakeStatus(status) }
            }

            override fun onWakeWordDetected() {
                Log.i(TAG, "Offline wake phrase detected")
                runOnUiThread {
                    publishWakeStatus(wakeWordController.currentState().name.lowercase())
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('energrid-native-wake-word'))",
                        null,
                    )
                }
            }

            override fun onCommandAudio(pcm16: ByteArray) {
                val encoded = Base64.encodeToString(pcm16, Base64.NO_WRAP)
                runOnUiThread {
                    webView.evaluateJavascript(
                        "window.energridNativeVoiceAudio && window.energridNativeVoiceAudio(${JSONObject.quote(encoded)})",
                        null,
                    )
                }
            }

            override fun onCommandEnded() {
                runOnUiThread {
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('energrid-native-command-ended'))",
                        null,
                    )
                }
            }

            override fun onSamplesChanged(status: String, positive: Int, negative: Int) {
                // Sample-training events are not part of the Android Home shell.
            }
        })

        CookieManager.getInstance().setAcceptCookie(true)
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            addJavascriptInterface(WakeWordBridge(), "EnergridWakeWord")
            addJavascriptInterface(NativeNotificationBridge(), "EnergridNotifications")

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val target = request?.url ?: return true
                    return !isDashboardPageUrl(target)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    pageReady = true
                    publishWakeStatus(wakeWordController.currentState().name.lowercase())
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread {
                        val audioOnly = request.resources.all { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                        if (!isDashboardOrigin(request.origin) || !audioOnly) return@runOnUiThread request.deny()
                        if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(request.resources)
                        } else {
                            pendingWebPermissionRequest?.deny()
                            pendingWebPermissionRequest = request
                            ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MICROPHONE)
                        }
                    }
                }
            }

            setBackgroundColor(android.graphics.Color.rgb(8, 13, 20))
        }

        setContentView(webView)
        requestNotificationPermissionIfNeeded()
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!webView.canGoBack()) {
                    finish()
                    return
                }
                val history = webView.copyBackForwardList()
                val previous = history.getItemAtIndex(history.currentIndex - 1)?.url
                if (isDashboardPageUrl(android.net.Uri.parse(previous))) webView.goBack()
                else loadDashboard()
            }
        })
        loadDashboard()
    }

    private fun loadDashboard() { webView.loadUrl(BuildConfig.DASHBOARD_URL) }

    private fun isDashboardOrigin(uri: android.net.Uri?): Boolean {
        if (uri == null) return false
        val dashboard = android.net.Uri.parse(BuildConfig.DASHBOARD_URL)
        return uri.scheme == dashboard.scheme && uri.host == dashboard.host && uri.port == dashboard.port
    }

    private fun isDashboardPageUrl(uri: android.net.Uri?): Boolean {
        return isDashboardOrigin(uri) && uri?.path?.trimEnd('/') == "/d/home"
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUI() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        )
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUI()
    }

    override fun onResume() {
        super.onResume()
        appVisible = true
        if (::wakeWordController.isInitialized && preferences.getBoolean(PREF_WAKE_ENABLED, false)) {
            enableWakeWord()
        }
    }

    override fun onPause() {
        appVisible = false
        if (::wakeWordController.isInitialized) wakeWordController.stop()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATIONS || requestCode == REQUEST_NOTIFICATIONS_STARTUP) {
            if (grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(this, "Allow notifications in Android Settings to receive Energrid alerts.", Toast.LENGTH_LONG).show()
            } else if (requestCode == REQUEST_NOTIFICATIONS) {
                showTestNotification()
            }
            return
        }
        if (requestCode != REQUEST_MICROPHONE) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "Microphone permission granted")
            pendingWebPermissionRequest?.let { request ->
                pendingWebPermissionRequest = null
                if (isDashboardOrigin(request.origin)) request.grant(request.resources) else request.deny()
                return
            }
            if (pendingManualPermission) {
                pendingManualPermission = false
                webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('energrid-mic-permission-granted'))", null)
                return
            }
            wakeWordController.setEnabled(true)
        } else {
            pendingWebPermissionRequest?.deny()
            pendingWebPermissionRequest = null
            if (pendingManualPermission) {
                pendingManualPermission = false
                dispatchManualCaptureFailed("Microphone permission was denied")
                return
            }
            preferences.edit().putBoolean(PREF_WAKE_ENABLED, false).apply()
            publishWakeStatus("permission_denied")
        }
    }

    private fun enableWakeWord() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            wakeWordController.setEnabled(true)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.RECORD_AUDIO),
                REQUEST_MICROPHONE,
            )
        }
    }

    private fun publishWakeStatus(status: String) {
        if (!pageReady || !::webView.isInitialized) return
        val detail = JSONObject()
            .put("enabled", preferences.getBoolean(PREF_WAKE_ENABLED, false))
            .put("status", status)
            .toString()
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('energrid-wake-status',{detail:$detail}))",
            null,
        )
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "Energrid notifications",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply { description = "Alerts from the Energrid Home dashboard" }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun requestTestNotification() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        } else showTestNotification()
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS_STARTUP)
        }
    }

    private fun showTestNotification() {
        showNotification(
            id = "local-test:${System.currentTimeMillis()}",
            severity = "info",
            title = "Energrid",
            message = "Тестовото известие работи.",
            allowWhileVisible = true,
        )
        Toast.makeText(this, "Test notification sent", Toast.LENGTH_SHORT).show()
    }

    private fun showNotification(id: String, severity: String, title: String, message: String, allowWhileVisible: Boolean = false) {
        if ((!allowWhileVisible && appVisible) || id.isBlank() || !NotificationManagerCompat.from(this).areNotificationsEnabled()) return
        val seen = notificationPreferences.getStringSet(NOTIFICATION_IDS_KEY, emptySet()).orEmpty().toMutableSet()
        if (!seen.add(id)) return
        while (seen.size > 100) seen.remove(seen.sorted().first())
        notificationPreferences.edit().putStringSet(NOTIFICATION_IDS_KEY, seen).apply()
        val openApp = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            id.hashCode(),
            openApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setContentTitle(title.take(80))
            .setContentText(message.take(160))
            .setStyle(NotificationCompat.BigTextStyle().bigText(message.take(500)))
            .setPriority(if (severity == "critical") NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        NotificationManagerCompat.from(this).notify(id.hashCode().and(Int.MAX_VALUE), notification)
    }

    private inner class NativeNotificationBridge {
        @JavascriptInterface
        fun testNotification() {
            runOnUiThread { requestTestNotification() }
        }

        @JavascriptInterface
        fun deliverNotification(id: String, severity: String, title: String, message: String) {
            if (id.isBlank() || id.length > 160 || severity !in setOf("info", "warning", "critical")) return
            runOnUiThread { showNotification(id, severity, title, message) }
        }
    }

    private inner class WakeWordBridge {
        @JavascriptInterface
        fun getStatus(): String = JSONObject()
            .put("enabled", preferences.getBoolean(PREF_WAKE_ENABLED, false))
            .put("status", wakeWordController.currentState().name.lowercase())
            .toString()

        @JavascriptInterface
        fun setEnabled(enabled: Boolean) {
            runOnUiThread {
                preferences.edit().putBoolean(PREF_WAKE_ENABLED, enabled).apply()
                if (enabled) enableWakeWord() else wakeWordController.setEnabled(false)
            }
        }

        @JavascriptInterface
        fun beginCommandCapture() {
            runOnUiThread { wakeWordController.beginCommandCapture() }
        }

        @JavascriptInterface
        fun startManualCommandCapture(): String {
            if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                return if (wakeWordController.startManualCommandCapture()) "started" else "busy"
            }
            runOnUiThread {
                pendingManualPermission = true
                ActivityCompat.requestPermissions(
                    this@MainActivity,
                    arrayOf(Manifest.permission.RECORD_AUDIO),
                    REQUEST_MICROPHONE,
                )
            }
            return "permission_pending"
        }

        @JavascriptInterface
        fun endManualCommandCapture() {
            runOnUiThread { wakeWordController.endManualCommandCapture() }
        }

        @JavascriptInterface
        fun assistantTurnFinished() {
            runOnUiThread { wakeWordController.assistantTurnFinished() }
        }
    }

    private fun dispatchManualCaptureFailed(reason: String) {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('energrid-native-manual-capture-failed',{detail:${JSONObject.quote(reason)}}))",
            null,
        )
    }

    override fun onDestroy() {
        wakeWordController.stop()
        webView.destroy()
        super.onDestroy()
    }
}
