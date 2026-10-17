package bg.energrid.home

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4

import org.junit.Test
import org.junit.runner.RunWith

import org.junit.Assert.*
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Instrumented test, which will execute on an Android device.
 *
 * See [testing documentation](http://d.android.com/tools/testing).
 */
@RunWith(AndroidJUnit4::class)
class ExampleInstrumentedTest {
    @Test
    fun useAppContext() {
        // Context of the app under test.
        val appContext = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("bg.energrid.home", appContext.packageName)
    }

    @Test
    fun reconcilesLegacyBackgroundWavWithoutChangingAudioOrInventingLabels() {
        val testContext = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(testContext.cacheDir, "wakeword-test-${java.util.UUID.randomUUID()}").apply { check(mkdirs()) }
        val folder = File(root, "negative/tv").apply { check(mkdirs()) }
        val session = "1792227693190"
        val wav = File(folder, "background_tv_${session}_01.wav")
        val pcm = ByteArray(32000)
        wav.writeBytes(wavBytes(pcm))
        val original = wav.readBytes()
        File(root, "background_manifest.csv").writeText(
            "file,category,session_id,segment,duration_seconds\nnegative/tv/${wav.name},tv,$session,1,1.0\n",
        )

        val result = ResearchDataset.reconcileDirectory(testContext, root)
        val metadata = org.json.JSONObject(File(folder, "${wav.nameWithoutExtension}.json").readText())

        assertEquals(1, result.recovered)
        assertEquals("tv", metadata.getString("category"))
        assertEquals(session, metadata.getString("session_id"))
        assertEquals("unlabeled", metadata.getString("label"))
        assertTrue(metadata.getBoolean("recovered_metadata"))
        assertEquals(1.0, metadata.getDouble("duration_seconds"), 0.001)
        assertEquals(original.toList(), wav.readBytes().toList())
        assertEquals(0, ResearchDataset.reconcileDirectory(testContext, root).recovered)
        root.deleteRecursively()
    }

    private fun wavBytes(pcm: ByteArray): ByteArray {
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray())
        header.putInt(36 + pcm.size)
        header.put("WAVEfmt ".toByteArray())
        header.putInt(16)
        header.putShort(1)
        header.putShort(1)
        header.putInt(16000)
        header.putInt(32000)
        header.putShort(2)
        header.putShort(16)
        header.put("data".toByteArray())
        header.putInt(pcm.size)
        return header.array() + pcm
    }
}
