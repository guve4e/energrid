package bg.energrid.home

import org.junit.Test

import org.junit.Assert.*
import java.time.Instant

/**
 * Example local unit test, which will execute on the development machine (host).
 *
 * See [testing documentation](http://d.android.com/tools/testing).
 */
class ExampleUnitTest {
    @Test
    fun addition_isCorrect() {
        assertEquals(4, 2 + 2)
    }

    @Test
    fun dailyScheduleUsesSofiaWindow() {
        assertFalse(DailyRecordingSchedule.isRecordingTime(Instant.parse("2026-10-17T04:59:59Z")))
        assertTrue(DailyRecordingSchedule.isRecordingTime(Instant.parse("2026-10-17T05:00:00Z")))
        assertTrue(DailyRecordingSchedule.isRecordingTime(Instant.parse("2026-10-17T20:59:59Z")))
        assertFalse(DailyRecordingSchedule.isRecordingTime(Instant.parse("2026-10-17T21:00:00Z")))
    }

    @Test
    fun dailyScheduleCalculatesNextLocalBoundary() {
        assertEquals(1_800_000L, DailyRecordingSchedule.millisUntilNextBoundary(Instant.parse("2026-10-17T04:30:00Z")))
        assertEquals(54_000_000L, DailyRecordingSchedule.millisUntilNextBoundary(Instant.parse("2026-10-17T06:00:00Z")))
        assertEquals(3_600_000L, DailyRecordingSchedule.millisUntilNextBoundary(Instant.parse("2026-10-17T20:00:00Z")))
    }

    @Test
    fun dailyScheduleTracksSofiaAcrossDaylightSavingChanges() {
        assertFalse(DailyRecordingSchedule.isRecordingTime(Instant.parse("2026-03-29T04:59:59Z")))
        assertTrue(DailyRecordingSchedule.isRecordingTime(Instant.parse("2026-03-29T05:00:00Z")))
        assertFalse(DailyRecordingSchedule.isRecordingTime(Instant.parse("2026-10-25T05:59:59Z")))
        assertTrue(DailyRecordingSchedule.isRecordingTime(Instant.parse("2026-10-25T06:00:00Z")))
    }
}
