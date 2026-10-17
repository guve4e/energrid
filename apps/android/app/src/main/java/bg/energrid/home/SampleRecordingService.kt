package bg.energrid.home

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

class SampleRecordingService : Service() {
    private var controller: WakeWordController? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var recording = false
    private var pausedForAssistant = false
    private var lastCaptureFailed = false
    private val scheduleHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val timeChangeReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context?, intent: Intent?) {
            reconcileDailySchedule()
        }
    }
    private val scheduleBoundary = object : Runnable {
        override fun run() = reconcileDailySchedule()
    }
    private lateinit var uploadQueue: SegmentUploadQueue
    private val retryHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val retryUploads = object : Runnable {
        override fun run() {
            if (!recording) return
            uploadQueue.enqueuePending()
            retryHandler.postDelayed(this, UPLOAD_RETRY_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        uploadQueue = SegmentUploadQueue(applicationContext)
        SegmentUploadScheduler.schedule(applicationContext)
        registerTimeChangeReceiver()
        controller = WakeWordController(applicationContext, object : WakeWordController.Listener {
            override fun onStatus(status: String) = Unit
            override fun onWakeWordDetected() = Unit
            override fun onCommandAudio(pcm16: ByteArray) = Unit
            override fun onCommandEnded() = Unit

            override fun onSamplesChanged(status: String, positive: Int, negative: Int) {
                sendStatus(status, positive, negative)
                lastCaptureFailed = status == "error" || status == "storage_limit"
                if (status in setOf("saved", "too_short") && pausedForAssistant) {
                    recording = false
                    releaseWakeLock()
                    updateNotification("Paused for assistant · research session will resume")
                    sendStatus("paused_for_assistant", positive, negative)
                } else if (status == "saved" || status == "error" || status == "too_short") finishRecording()
            }

            override fun onSegmentSaved(segment: SavedSegment) {
                sendSegmentStatus(segment)
                SegmentUploadScheduler.schedule(applicationContext)
                uploadQueue.enqueuePending()
            }
        })
        uploadQueue.enqueuePending()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                disableDailySchedule()
                if (recording) {
                    updateNotification("Stopping recording…")
                    controller?.stopSampleRecording()
                } else if (pausedForAssistant || getSharedPreferences(PREFERENCES, MODE_PRIVATE).contains(KEY_CATEGORY)) finishRecording()
                else stopSelf(startId)
            }
            ACTION_PAUSE_FOR_ASSISTANT -> pauseForAssistant()
            ACTION_RESUME_AFTER_ASSISTANT -> resumeAfterAssistant(startId)
            ACTION_ENABLE_DAILY -> enableDailySchedule(intent.getStringExtra(EXTRA_LABEL), startId)
            ACTION_DISABLE_DAILY -> {
                disableDailySchedule()
                if (recording) controller?.stopSampleRecording()
                else if (pausedForAssistant || getSharedPreferences(PREFERENCES, MODE_PRIVATE).contains(KEY_CATEGORY)) finishRecording()
                else stopScheduleService()
            }
            ACTION_START -> startRecording(intent.getStringExtra(EXTRA_LABEL), startId, java.util.UUID.randomUUID().toString())
            ACTION_SCHEDULE_TICK -> reconcileDailySchedule()
            null -> resumeServiceState(startId)
            else -> stopSelf(startId)
        }
        return START_STICKY
    }

    private fun startRecording(label: String?, startId: Int, resumedSessionId: String? = null) {
        if (recording) return
        if (label.isNullOrBlank() || !label.startsWith("background:")) {
            Log.w(TAG, "Rejected invalid foreground sample label")
            stopSelf(startId)
            return
        }
        val prefs = getSharedPreferences(PREFERENCES, MODE_PRIVATE)
        val sessionId = resumedSessionId ?: prefs.getString(KEY_SESSION_ID, null) ?: java.util.UUID.randomUUID().toString()
        startForeground(NOTIFICATION_ID, buildNotification("Research recording · ${label.substringAfter(':')} · stored on device", ongoing = true))
        try {
            val powerManager = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:sample-recording").apply {
                setReferenceCounted(false)
                acquire()
            }
            recording = true
            pausedForAssistant = false
            prefs.edit().putString(KEY_CATEGORY, label).putString(KEY_SESSION_ID, sessionId).apply()
            sendStatus("recording", 0, 0)
            controller?.startSampleRecording(label, sessionId)
            retryHandler.removeCallbacks(retryUploads)
            retryHandler.post(retryUploads)
            Log.i(TAG, "Started foreground local research recording label=$label session=$sessionId")
        } catch (error: Exception) {
            Log.e(TAG, "Could not start foreground sample recording", error)
            sendStatus("error", 0, 0)
            finishRecording()
        }
    }

    private fun pauseForAssistant() {
        if (!recording) return
        pausedForAssistant = true
        updateNotification("Pausing for voice assistant…")
        controller?.stopSampleRecording()
    }

    private fun resumeAfterAssistant(startId: Int) {
        if (!pausedForAssistant) return
        val prefs = getSharedPreferences(PREFERENCES, MODE_PRIVATE)
        val label = prefs.getString(KEY_CATEGORY, null)
        val session = prefs.getString(KEY_SESSION_ID, null)
        if (label == null || session == null) {
            finishRecording()
            return
        }
        if (isDailyEnabled() && !DailyRecordingSchedule.isRecordingTime(java.time.Instant.now())) {
            finishRecording()
            return
        }
        recording = true
        pausedForAssistant = false
        sendStatus("recording", 0, 0)
        controller?.startSampleRecording(label, session)
        updateNotification("Research recording resumed · ${label.substringAfter(':')}")
        retryHandler.removeCallbacks(retryUploads)
        retryHandler.post(retryUploads)
        Log.i(TAG, "Resumed local research session=$session after assistant turn")
    }

    private fun resumeSavedSession(startId: Int) {
        val prefs = getSharedPreferences(PREFERENCES, MODE_PRIVATE)
        val label = prefs.getString(KEY_CATEGORY, null)
        val sessionId = prefs.getString(KEY_SESSION_ID, null)
        if (label == null || sessionId == null) {
            stopSelf(startId)
            return
        }
        recording = false
        prefs.edit().remove(KEY_CATEGORY).remove(KEY_SESSION_ID).apply()
        startRecording(label, startId, sessionId)
    }

    private fun resumeServiceState(startId: Int) {
        if (isDailyEnabled()) {
            startForeground(NOTIFICATION_ID, buildNotification("Daily schedule enabled · checking local recording window", ongoing = true))
            reconcileDailySchedule()
        } else resumeSavedSession(startId)
    }

    private fun enableDailySchedule(label: String?, startId: Int) {
        if (label.isNullOrBlank() || !label.startsWith("background:")) {
            Log.w(TAG, "Rejected invalid daily recording category")
            stopSelf(startId)
            return
        }
        getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit()
            .putBoolean(KEY_DAILY_ENABLED, true)
            .putString(KEY_DAILY_CATEGORY, label)
            .apply()
        startForeground(NOTIFICATION_ID, buildNotification("Daily schedule enabled · 08:00–00:00 Sofia", ongoing = true))
        reconcileDailySchedule()
    }

    private fun disableDailySchedule() {
        getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit()
            .putBoolean(KEY_DAILY_ENABLED, false)
            .remove(KEY_DAILY_CATEGORY)
            .apply()
        scheduleHandler.removeCallbacks(scheduleBoundary)
    }

    private fun stopScheduleService() {
        retryHandler.removeCallbacks(retryUploads)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun reconcileDailySchedule() {
        if (!isDailyEnabled()) return
        scheduleHandler.removeCallbacks(scheduleBoundary)
        scheduleHandler.removeCallbacks(dailyRetry)
        val prefs = getSharedPreferences(PREFERENCES, MODE_PRIVATE)
        val category = prefs.getString(KEY_DAILY_CATEGORY, null) ?: return
        if (DailyRecordingSchedule.isRecordingTime(java.time.Instant.now())) {
            if (!recording && !pausedForAssistant) {
                startRecording(category, 0, java.util.UUID.randomUUID().toString())
            }
            if (recording) updateNotification("Daily research recording active · ${category.substringAfter(':')}")
        } else if (recording) {
            updateNotification("Daily recording window ended · finalizing segment")
            controller?.stopSampleRecording()
        } else {
            updateNotification("Daily schedule enabled · next recording at 08:00 Sofia")
        }
        val delay = DailyRecordingSchedule.millisUntilNextBoundary(java.time.Instant.now())
        scheduleHandler.postDelayed(scheduleBoundary, delay)
    }

    private val dailyRetry = Runnable { reconcileDailySchedule() }

    private fun registerTimeChangeReceiver() {
        val filter = android.content.IntentFilter().apply {
            addAction(Intent.ACTION_TIME_CHANGED)
            addAction(Intent.ACTION_TIMEZONE_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(timeChangeReceiver, filter, RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") registerReceiver(timeChangeReceiver, filter)
    }

    private fun isDailyEnabled(): Boolean = getSharedPreferences(PREFERENCES, MODE_PRIVATE)
        .getBoolean(KEY_DAILY_ENABLED, false)

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun finishRecording() {
        if (!recording && !pausedForAssistant && !getSharedPreferences(PREFERENCES, MODE_PRIVATE).contains(KEY_CATEGORY)) return
        recording = false
        pausedForAssistant = false
        retryHandler.removeCallbacks(retryUploads)
        uploadQueue.enqueuePending()
        releaseWakeLock()
        getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit().remove(KEY_CATEGORY).remove(KEY_SESSION_ID).apply()
        sendStatus(if (isDailyEnabled()) "scheduled_idle" else "stopped", 0, 0)
        if (isDailyEnabled()) {
            val withinWindow = DailyRecordingSchedule.isRecordingTime(java.time.Instant.now())
            updateNotification(if (withinWindow) "Daily recording paused · retrying shortly" else "Daily schedule enabled · next recording at 08:00 Sofia")
            scheduleHandler.removeCallbacks(scheduleBoundary)
            if (withinWindow && lastCaptureFailed) scheduleHandler.postDelayed(dailyRetry, DAILY_RETRY_MS)
            else reconcileDailySchedule()
            lastCaptureFailed = false
            return
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun sendStatus(status: String, positive: Int, negative: Int) {
        val counts = runCatching { org.json.JSONObject(controller?.sampleCountsJson() ?: "{}") }.getOrDefault(org.json.JSONObject())
        val update = Intent(ACTION_STATUS).setPackage(packageName)
            .putExtra(EXTRA_STATUS, status)
            .putExtra(EXTRA_POSITIVE, counts.optInt("positive", positive))
            .putExtra(EXTRA_NEGATIVE, counts.optInt("negative", negative))
        sendBroadcast(update)
        if (status == "recording") updateNotification("Recording locally · tap Stop when finished")
    }

    private fun sendSegmentStatus(segment: SavedSegment) {
        val metadata = segment.metadata
        val counts = runCatching { org.json.JSONObject(controller?.sampleCountsJson() ?: "{}") }.getOrDefault(org.json.JSONObject())
        val update = Intent(ACTION_STATUS).setPackage(packageName)
            .putExtra(EXTRA_STATUS, "segment_saved")
            .putExtra(EXTRA_POSITIVE, counts.optInt("positive", 0))
            .putExtra(EXTRA_NEGATIVE, counts.optInt("negative", 0))
            .putExtra(EXTRA_SESSION_ID, metadata.optString("session_id"))
            .putExtra(EXTRA_SEGMENT_ID, segment.clipId)
            .putExtra(EXTRA_UPLOAD_STATUS, metadata.optString("upload_status"))
        sendBroadcast(update)
        updateNotification("Recording locally · segment saved · upload queued")
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(text, ongoing = true))
    }

    private fun buildNotification(text: String, ongoing: Boolean): Notification {
        val stopIntent = PendingIntent.getService(
            this,
            2,
            Intent(this, SampleRecordingService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setContentTitle("Energrid audio capture")
            .setContentText(text)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(ongoing)
            .setOnlyAlertOnce(true)
            .addAction(0, "Stop", stopIntent)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Audio sample recording", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        retryHandler.removeCallbacks(retryUploads)
        scheduleHandler.removeCallbacks(scheduleBoundary)
        scheduleHandler.removeCallbacks(dailyRetry)
        runCatching { unregisterReceiver(timeChangeReceiver) }
        if (recording) controller?.stopSampleRecording()
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        controller?.stop()
        controller = null
        if (::uploadQueue.isInitialized) uploadQueue.close()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "bg.energrid.home.action.START_SAMPLE_RECORDING"
        const val ACTION_STOP = "bg.energrid.home.action.STOP_SAMPLE_RECORDING"
        const val ACTION_STATUS = "bg.energrid.home.action.SAMPLE_RECORDING_STATUS"
        const val ACTION_PAUSE_FOR_ASSISTANT = "bg.energrid.home.action.PAUSE_RESEARCH_FOR_ASSISTANT"
        const val ACTION_RESUME_AFTER_ASSISTANT = "bg.energrid.home.action.RESUME_RESEARCH_AFTER_ASSISTANT"
        const val ACTION_ENABLE_DAILY = "bg.energrid.home.action.ENABLE_DAILY_RESEARCH"
        const val ACTION_DISABLE_DAILY = "bg.energrid.home.action.DISABLE_DAILY_RESEARCH"
        const val ACTION_SCHEDULE_TICK = "bg.energrid.home.action.DAILY_RESEARCH_TICK"
        const val EXTRA_LABEL = "label"
        const val EXTRA_STATUS = "status"
        const val EXTRA_POSITIVE = "positive"
        const val EXTRA_NEGATIVE = "negative"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_SEGMENT_ID = "segment_id"
        const val EXTRA_UPLOAD_STATUS = "upload_status"
        const val PREFERENCES = "sample-recording"
        const val KEY_CATEGORY = "category"
        const val KEY_SESSION_ID = "session_id"
        const val KEY_DAILY_ENABLED = "daily_enabled"
        const val KEY_DAILY_CATEGORY = "daily_category"

        private const val TAG = "EnergridRecording"
        const val CHANNEL_ID = "energrid_audio_recording"
        private const val NOTIFICATION_ID = 2001
        private const val UPLOAD_RETRY_MS = 60_000L
        private const val DAILY_RETRY_MS = 60_000L
    }
}
