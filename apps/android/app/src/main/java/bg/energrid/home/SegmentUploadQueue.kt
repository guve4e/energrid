package bg.energrid.home

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal class SegmentUploadQueue(context: Context) {
    private val appContext = context.applicationContext
    private val executor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "energrid-audio-upload") }
    private val running = AtomicBoolean(false)
    private val root = File(appContext.filesDir, "wakeword-samples")

    fun enqueuePending() {
        if (!running.compareAndSet(false, true)) return
        executor.execute {
            try {
                uploadPending()
            } finally {
                running.set(false)
            }
        }
    }

    fun close() {
        executor.shutdownNow()
    }

    private fun uploadPending() {
        val baseUrl = ResearchDataset.ingestBaseUrl(appContext) ?: return
        val token = ResearchDataset.ingestToken(appContext) ?: return
        root.walkTopDown().filter { it.isFile && it.extension == "json" }.forEach { metadataFile ->
            val metadata = runCatching { JSONObject(metadataFile.readText(Charsets.UTF_8)) }.getOrNull() ?: return@forEach
            if (metadata.optString("upload_status") == "uploaded") return@forEach
            val audio = File(metadataFile.parentFile, metadataFile.nameWithoutExtension + ".wav")
            if (!audio.isFile) return@forEach
            try {
                val clipId = metadata.getString("clip_id")
                val status = request("GET", "$baseUrl/v1/uploads/$clipId", token)
                if (status.first !in 200..299) throw IllegalStateException("resume check HTTP ${status.first}")
                val resume = JSONObject(status.second)
                var offset = resume.optLong("next_offset", 0L).coerceIn(0L, audio.length())
                if (resume.optBoolean("complete")) {
                    markUploaded(metadataFile, metadata)
                    return@forEach
                }
                RandomAccessFile(audio, "r").use { input ->
                    input.seek(offset)
                    while (offset < audio.length()) {
                        val chunk = ByteArray(minOf(CHUNK_BYTES.toLong(), audio.length() - offset).toInt())
                        var filled = 0
                        while (filled < chunk.size) {
                            val read = input.read(chunk, filled, chunk.size - filled)
                            if (read < 0) throw IllegalStateException("unexpected end of audio segment")
                            filled += read
                        }
                        val end = offset + chunk.size - 1
                        val connection = (URL("$baseUrl/v1/uploads/$clipId").openConnection() as HttpURLConnection).apply {
                            requestMethod = "PUT"
                            connectTimeout = 8_000
                            readTimeout = 30_000
                            doOutput = true
                            setFixedLengthStreamingMode(chunk.size)
                            setRequestProperty("Authorization", "Bearer $token")
                            setRequestProperty("Content-Type", "application/octet-stream")
                            setRequestProperty("Content-Range", "bytes $offset-$end/${audio.length()}")
                            setRequestProperty("X-Segment-Metadata", metadata.toString())
                            setRequestProperty("X-SHA256", metadata.getString("sha256"))
                        }
                        connection.outputStream.use { it.write(chunk) }
                        val code = connection.responseCode
                        val response = (if (code >= 400) connection.errorStream else connection.inputStream)
                            ?.bufferedReader()?.use { it.readText() }.orEmpty()
                        connection.disconnect()
                        if (code !in setOf(200, 201, 308, 409)) throw IllegalStateException("upload HTTP $code: $response")
                        val ack = JSONObject(response)
                        if (ack.optBoolean("acknowledged")) {
                            markUploaded(metadataFile, metadata)
                            Log.i(TAG, "Upload acknowledged clip=$clipId bytes=${audio.length()}")
                            break
                        }
                        val nextOffset = ack.optLong("next_offset", -1L)
                        if (nextOffset < 0L || nextOffset > audio.length() || (nextOffset == offset && code != 409)) {
                            throw IllegalStateException("invalid resume offset=$nextOffset after=$offset")
                        }
                        offset = nextOffset
                        input.seek(offset)
                    }
                }
            } catch (error: Exception) {
                Log.w(TAG, "Upload deferred clip=${metadata.optString("clip_id")}; will retry", error)
            }
        }
    }

    private fun request(method: String, url: String, token: String): Pair<Int, String> {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 8_000
            readTimeout = 15_000
            setRequestProperty("Authorization", "Bearer $token")
        }
        return try {
            val code = connection.responseCode
            val body = (if (code >= 400) connection.errorStream else connection.inputStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            code to body
        } finally { connection.disconnect() }
    }

    private fun markUploaded(metadataFile: File, metadata: JSONObject) {
        metadata.put("upload_status", "uploaded").put("uploaded_at", java.time.Instant.now().toString())
        val temp = File(metadataFile.parentFile, metadataFile.name + ".tmp")
        temp.writeText(metadata.toString(), Charsets.UTF_8)
        check(temp.renameTo(metadataFile))
    }

    companion object {
        private const val TAG = "EnergridUploadQueue"
        private const val CHUNK_BYTES = 1024 * 1024
    }
}
