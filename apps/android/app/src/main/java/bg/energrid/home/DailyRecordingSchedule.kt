package bg.energrid.home

import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

internal object DailyRecordingSchedule {
    private val zone = ZoneId.of("Europe/Sofia")
    private val start = LocalTime.of(8, 0)
    private val end = LocalTime.MIDNIGHT

    fun isRecordingTime(now: Instant): Boolean {
        val time = now.atZone(zone).toLocalTime()
        return !time.isBefore(start)
    }

    fun millisUntilNextBoundary(now: Instant): Long {
        val localNow = now.atZone(zone)
        val boundary = if (isRecordingTime(now)) {
            localNow.toLocalDate().plusDays(1).atTime(end).atZone(zone)
        } else {
            val date = if (localNow.toLocalTime().isBefore(start)) localNow.toLocalDate() else localNow.toLocalDate().plusDays(1)
            date.atTime(start).atZone(zone)
        }
        return java.time.Duration.between(now, boundary.toInstant()).toMillis().coerceAtLeast(1)
    }
}
