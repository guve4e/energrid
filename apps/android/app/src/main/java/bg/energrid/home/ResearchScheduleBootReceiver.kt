package bg.energrid.home

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

class ResearchScheduleBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
        val preferences = context.getSharedPreferences(SampleRecordingService.PREFERENCES, Context.MODE_PRIVATE)
        if (!preferences.getBoolean(SampleRecordingService.KEY_DAILY_ENABLED, false)) return

        createChannel(context)
        val category = preferences.getString(SampleRecordingService.KEY_DAILY_CATEGORY, null) ?: return
        val resume = PendingIntent.getService(
            context,
            NOTIFICATION_ID,
            Intent(context, SampleRecordingService::class.java)
                .setAction(SampleRecordingService.ACTION_ENABLE_DAILY)
                .putExtra(SampleRecordingService.EXTRA_LABEL, category),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, SampleRecordingService.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setContentTitle("Energrid daily recording paused")
            .setContentText("Tap to resume the 08:00–00:00 Sofia schedule")
            .setAutoCancel(true)
            .setContentIntent(resume)
            .addAction(0, "Resume schedule", resume)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
    }

    private fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            SampleRecordingService.CHANNEL_ID,
            "Audio sample recording",
            NotificationManager.IMPORTANCE_DEFAULT,
        )
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        private const val NOTIFICATION_ID = 2002
    }
}
