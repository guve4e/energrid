package bg.energrid.home

import android.annotation.SuppressLint
import android.Manifest
import android.content.pm.PackageManager
import android.content.pm.ActivityInfo
import android.content.Intent
import android.content.ClipData
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.widget.Toast
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceResponse
import java.io.FileInputStream
import java.net.URLDecoder
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var wakeWordController: WakeWordController
    private lateinit var uploadQueue: SegmentUploadQueue
    private val preferences by lazy { getSharedPreferences("wake-word", MODE_PRIVATE) }
    private var pageReady = false
    private var pendingSampleLabel: String? = null
    private var pendingDailyLabel: String? = null
    private var pendingManualPermission = false
    private val tabletExperience: Boolean by lazy { resources.configuration.smallestScreenWidthDp >= 600 }
    private val mobileExperience: Boolean get() = !tabletExperience
    private var sampleReceiverRegistered = false
    private val sampleStatusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: android.content.Context?, intent: Intent?) {
            val detail = JSONObject()
                .put("status", intent?.getStringExtra(SampleRecordingService.EXTRA_STATUS) ?: "unknown")
                .put("positive", intent?.getIntExtra(SampleRecordingService.EXTRA_POSITIVE, 0) ?: 0)
                .put("negative", intent?.getIntExtra(SampleRecordingService.EXTRA_NEGATIVE, 0) ?: 0)
                .put("category", getSharedPreferences(SampleRecordingService.PREFERENCES, MODE_PRIVATE)
                    .getString(SampleRecordingService.KEY_CATEGORY, ""))
                .put("sessionId", intent?.getStringExtra(SampleRecordingService.EXTRA_SESSION_ID) ?: "")
                .put("segmentId", intent?.getStringExtra(SampleRecordingService.EXTRA_SEGMENT_ID) ?: "")
                .put("uploadStatus", intent?.getStringExtra(SampleRecordingService.EXTRA_UPLOAD_STATUS) ?: "")
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('energrid-wake-samples',{detail:$detail}))",
                null,
            )
            if (intent?.getStringExtra(SampleRecordingService.EXTRA_STATUS) == "paused_for_assistant") {
                webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('energrid-research-paused'))", null)
            }
            val state = intent?.getStringExtra(SampleRecordingService.EXTRA_STATUS)
            if (state == "stopped") {
                SegmentUploadScheduler.schedule(this@MainActivity)
                uploadQueue.enqueuePending()
            }
            if (state == "stopped" && preferences.getBoolean(PREF_WAKE_ENABLED, false) &&
                getSharedPreferences(SampleRecordingService.PREFERENCES, MODE_PRIVATE)
                    .getString(SampleRecordingService.KEY_CATEGORY, null) == null) {
                enableWakeWord()
            }
        }
    }

    companion object {
        private const val TAG = "EnergridKiosk"
        private const val REQUEST_MICROPHONE = 4102
        private const val REQUEST_NOTIFICATIONS = 4103
        private const val NOTIFICATION_CHANNEL_ID = "energrid_alerts"
        private const val PREF_WAKE_ENABLED = "enabled"
        private const val DASHBOARD_BASE_URL =
            "http://192.168.1.60/home/"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (mobileExperience) {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        } else {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            hideSystemUI()
        }
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
                if (status == "saved" && ::uploadQueue.isInitialized) {
                    SegmentUploadScheduler.schedule(applicationContext)
                    uploadQueue.enqueuePending()
                }
                runOnUiThread {
                    val detail = JSONObject().put("status", status).put("positive", positive).put("negative", negative)
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('energrid-wake-samples',{detail:${detail}}))",
                        null,
                    )
                }
            }
        })

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            addJavascriptInterface(WakeWordBridge(), "EnergridWakeWord")
            addJavascriptInterface(NativeNotificationBridge(), "EnergridNotifications")

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                    return interceptResearchAudio(request?.url?.toString()) ?: super.shouldInterceptRequest(view, request)
                }

                @Suppress("DEPRECATION")
                override fun shouldInterceptRequest(view: WebView?, url: String?): WebResourceResponse? {
                    return interceptResearchAudio(url) ?: super.shouldInterceptRequest(view, url)
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val target = request?.url ?: return true
                    val dashboard = android.net.Uri.parse(dashboardUrl())
                    return target.scheme != dashboard.scheme ||
                        target.host != dashboard.host || target.port != dashboard.port
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    pageReady = true
                    publishWakeStatus(wakeWordController.currentState().name.lowercase())
                }
            }

            setBackgroundColor(android.graphics.Color.rgb(8, 13, 20))
        }

        setContentView(webView)
        uploadQueue = SegmentUploadQueue(applicationContext)
        SegmentUploadScheduler.schedule(applicationContext)
        uploadQueue.enqueuePending()
        val filter = IntentFilter(SampleRecordingService.ACTION_STATUS)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(sampleStatusReceiver, filter, RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") registerReceiver(sampleStatusReceiver, filter)
        sampleReceiverRegistered = true
        webView.loadUrl(dashboardUrl())
    }

    private fun dashboardUrl(): String = if (mobileExperience) {
        DASHBOARD_BASE_URL.replace("/home/", "/mobile/")
    } else DASHBOARD_BASE_URL

    private fun interceptResearchAudio(url: String?): WebResourceResponse? {
        val uri = runCatching { android.net.Uri.parse(url) }.getOrNull() ?: return null
        if (uri.scheme != "https" || uri.host != "energrid.local" || !uri.path.orEmpty().startsWith("/research-audio/")) return null
        val clipId = URLDecoder.decode(uri.lastPathSegment ?: "", "UTF-8")
        val file = wakeWordController.reviewAudioFile(clipId)
            ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "Not found".byteInputStream())
        return WebResourceResponse("audio/wav", null, FileInputStream(file))
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
        if (hasFocus && tabletExperience) hideSystemUI()
    }

    override fun onResume() {
        super.onResume()
        resumeDailyRecordingAfterAppOpen()
        if (tabletExperience && ::wakeWordController.isInitialized && preferences.getBoolean(PREF_WAKE_ENABLED, false)) {
            enableWakeWord()
        }
    }

    private fun resumeDailyRecordingAfterAppOpen() {
        val settings = getSharedPreferences(SampleRecordingService.PREFERENCES, MODE_PRIVATE)
        if (!settings.getBoolean(SampleRecordingService.KEY_DAILY_ENABLED, false)) return
        val category = settings.getString(SampleRecordingService.KEY_DAILY_CATEGORY, null) ?: return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
        ContextCompat.startForegroundService(
            this,
            Intent(this, SampleRecordingService::class.java)
                .setAction(SampleRecordingService.ACTION_ENABLE_DAILY)
                .putExtra(SampleRecordingService.EXTRA_LABEL, category),
        )
    }

    override fun onPause() {
        if (::wakeWordController.isInitialized) wakeWordController.stop()
        super.onPause()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATIONS) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) showTestNotification()
            else Toast.makeText(this, "Allow notifications in Android Settings to receive Energrid alerts.", Toast.LENGTH_LONG).show()
            return
        }
        if (requestCode != REQUEST_MICROPHONE) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "Microphone permission granted")
            if (pendingManualPermission) {
                pendingManualPermission = false
                return
            }
            val sampleLabel = pendingSampleLabel.also { pendingSampleLabel = null }
            val dailyLabel = pendingDailyLabel.also { pendingDailyLabel = null }
            when {
                dailyLabel != null -> enableDailyRecordingInternal(dailyLabel)
                sampleLabel != null -> startSampleRecordingInternal(sampleLabel)
                else -> wakeWordController.setEnabled(true)
            }
        } else {
            if (pendingManualPermission) {
                pendingManualPermission = false
                dispatchManualCaptureFailed("Microphone permission was denied")
                return
            }
            pendingSampleLabel = null
            pendingDailyLabel = null
            preferences.edit().putBoolean(PREF_WAKE_ENABLED, false).apply()
            publishWakeStatus("permission_denied")
        }
    }

    private fun enableWakeWord() {
        if (getSharedPreferences(SampleRecordingService.PREFERENCES, MODE_PRIVATE)
                .getString(SampleRecordingService.KEY_CATEGORY, null) != null) {
            publishWakeStatus("paused_for_research_recording")
            return
        }
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

    private fun startSampleRecordingInternal(label: String) {
        if (label.startsWith("background:")) {
            wakeWordController.setEnabled(false)
            val serviceIntent = Intent(this, SampleRecordingService::class.java)
                .setAction(SampleRecordingService.ACTION_START)
                .putExtra(SampleRecordingService.EXTRA_LABEL, label)
            ContextCompat.startForegroundService(this, serviceIntent)
        } else wakeWordController.startSampleRecording(label)
    }

    private fun enableDailyRecordingInternal(label: String) {
        wakeWordController.setEnabled(false)
        ContextCompat.startForegroundService(
            this,
            Intent(this, SampleRecordingService::class.java)
                .setAction(SampleRecordingService.ACTION_ENABLE_DAILY)
                .putExtra(SampleRecordingService.EXTRA_LABEL, label),
        )
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
            "Energrid alerts",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply { description = "Important home system alerts and notification tests" }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun requestTestNotification() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        } else showTestNotification()
    }

    private fun showTestNotification() {
        val openApp = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("experience", "mobile")
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            1,
            openApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setContentTitle("Energrid")
            .setContentText("Тестово известие от Energrid. Системата работи успешно.")
            .setStyle(NotificationCompat.BigTextStyle().bigText("Тестово известие от Energrid. Системата работи успешно."))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        NotificationManagerCompat.from(this).notify(1001, notification)
        Toast.makeText(this, "Test notification sent", Toast.LENGTH_SHORT).show()
    }

    private inner class NativeNotificationBridge {
        @JavascriptInterface
        fun testNotification() {
            runOnUiThread { requestTestNotification() }
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

        @JavascriptInterface
        fun pauseResearchForAssistant() {
            runOnUiThread {
                startService(Intent(this@MainActivity, SampleRecordingService::class.java)
                    .setAction(SampleRecordingService.ACTION_PAUSE_FOR_ASSISTANT))
            }
        }

        @JavascriptInterface
        fun resumeResearchAfterAssistant() {
            runOnUiThread {
                startService(Intent(this@MainActivity, SampleRecordingService::class.java)
                    .setAction(SampleRecordingService.ACTION_RESUME_AFTER_ASSISTANT))
            }
        }

        @JavascriptInterface
        fun getSamples(): String {
            val counts = JSONObject(wakeWordController.sampleCountsJson())
            val category = getSharedPreferences(SampleRecordingService.PREFERENCES, MODE_PRIVATE)
                .getString(SampleRecordingService.KEY_CATEGORY, null)
            counts.put("status", if (category != null) "recording" else counts.optString("status", "idle"))
                .put("category", category ?: "")
                .put("dailyScheduleEnabled", getSharedPreferences(SampleRecordingService.PREFERENCES, MODE_PRIVATE)
                    .getBoolean(SampleRecordingService.KEY_DAILY_ENABLED, false))
                .put("dailyCategory", getSharedPreferences(SampleRecordingService.PREFERENCES, MODE_PRIVATE)
                    .getString(SampleRecordingService.KEY_DAILY_CATEGORY, "") ?: "")
            return counts.toString()
        }

        @JavascriptInterface
        fun getRecorderCapabilities(): String = JSONObject()
            .put("backgroundSessions", true)
            .put("segmentedWav", true)
            .put("researchMode", true)
            .put("dailySchedule", true)
            .put("localReview", true)
            .put("lanUpload", true)
            .put("backgroundCategories", org.json.JSONArray(listOf("tv", "english_tv", "conversation", "household", "mixed")))
            .toString()

        @JavascriptInterface
        fun getReviewSegments(): String = wakeWordController.reviewSegmentsJson()

        @JavascriptInterface
        fun labelClip(clipId: String, label: String, occurrencesJson: String): Boolean =
            wakeWordController.labelClip(clipId, label, occurrencesJson)

        @JavascriptInterface
        fun deleteClip(clipId: String): Boolean = wakeWordController.deleteClip(clipId)

        @JavascriptInterface
        fun getUploadConfig(): String = JSONObject()
            .put("url", ResearchDataset.ingestBaseUrl(this@MainActivity) ?: "")
            .put("configured", ResearchDataset.ingestBaseUrl(this@MainActivity) != null && ResearchDataset.ingestToken(this@MainActivity) != null)
            .toString()

        @JavascriptInterface
        fun getUploadStatus(): String = uploadQueue.statusJson()

        @JavascriptInterface
        fun configureUpload(baseUrl: String, token: String): String = runCatching {
            ResearchDataset.configure(this@MainActivity, baseUrl, token)
            SegmentUploadScheduler.schedule(this@MainActivity)
            uploadQueue.enqueuePending()
            JSONObject().put("ok", true).toString()
        }.getOrElse { JSONObject().put("ok", false).put("error", it.message ?: "Configuration failed").toString() }

        @JavascriptInterface
        fun uploadPending(): Boolean {
            SegmentUploadScheduler.schedule(this@MainActivity)
            uploadQueue.enqueuePending()
            return true
        }

        @JavascriptInterface
        fun startSampleRecording(label: String) {
            runOnUiThread {
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    this@MainActivity.startSampleRecordingInternal(label)
                } else {
                    pendingSampleLabel = label
                    ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MICROPHONE)
                }
            }
        }

        @JavascriptInterface
        fun enableDailySchedule(label: String) {
            runOnUiThread {
                if (!label.startsWith("background:")) return@runOnUiThread
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    this@MainActivity.enableDailyRecordingInternal(label)
                } else {
                    pendingDailyLabel = label
                    ActivityCompat.requestPermissions(
                        this@MainActivity,
                        arrayOf(Manifest.permission.RECORD_AUDIO),
                        REQUEST_MICROPHONE,
                    )
                }
            }
        }

        @JavascriptInterface
        fun disableDailySchedule() {
            runOnUiThread {
                startService(Intent(this@MainActivity, SampleRecordingService::class.java)
                    .setAction(SampleRecordingService.ACTION_DISABLE_DAILY))
            }
        }

        @JavascriptInterface
        fun stopSampleRecording() {
            runOnUiThread {
                val category = getSharedPreferences(SampleRecordingService.PREFERENCES, MODE_PRIVATE)
                    .getString(SampleRecordingService.KEY_CATEGORY, null)
                if (category?.startsWith("background:") == true) {
                    startService(Intent(this@MainActivity, SampleRecordingService::class.java).setAction(SampleRecordingService.ACTION_STOP))
                } else wakeWordController.stopSampleRecording()
            }
        }

        @JavascriptInterface
        fun exportSamples() {
            runOnUiThread {
                runCatching {
                    val archive = wakeWordController.exportSamples()
                    val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", archive)
                    val share = Intent(Intent.ACTION_SEND).apply {
                        type = "application/zip"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        clipData = ClipData.newUri(contentResolver, "Wake-word samples", uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    Log.i(TAG, "Prepared wake sample archive (${archive.length()} bytes)")
                    startActivity(Intent.createChooser(share, "Share wake-word samples"))
                }.onFailure {
                    Log.e(TAG, "Could not export wake samples", it)
                    Toast.makeText(this@MainActivity, "Could not prepare wake-word samples for sharing", Toast.LENGTH_LONG).show()
                }
            }
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
        if (sampleReceiverRegistered) unregisterReceiver(sampleStatusReceiver)
        wakeWordController.stop()
        if (::uploadQueue.isInitialized) uploadQueue.close()
        webView.destroy()
        super.onDestroy()
    }
}
