package bg.energrid.home

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal class SegmentUploadQueue(context: Context) {
    private val appContext = context.applicationContext
    private val executor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "energrid-audio-upload") }
    private val running = AtomicBoolean(false)
    private val root = File(appContext.filesDir, "wakeword-samples")
    private val receiptsRoot = File(appContext.filesDir, "wakeword-upload-receipts")

    fun enqueuePending(onComplete: ((Boolean) -> Unit)? = null) {
        if (!running.compareAndSet(false, true)) {
            onComplete?.invoke(snapshot().optInt("pending", 0) > 0)
            return
        }
        executor.execute {
            var hasPending = true
            try {
                hasPending = uploadPending()
            } finally {
                running.set(false)
                onComplete?.invoke(hasPending)
            }
        }
    }

    fun statusJson(): String = snapshot().toString()

    fun close() {
        executor.shutdownNow()
    }

    private fun uploadPending(): Boolean {
        val reconciliation = ResearchDataset.reconcileMissingMetadata(appContext)
        if (reconciliation.recovered > 0) Log.i(TAG, "Recovered metadata for ${reconciliation.recovered} WAV files")
        if (reconciliation.invalid > 0) Log.e(TAG, "Could not validate ${reconciliation.invalid} WAV files; originals preserved")
        val baseUrl = ResearchDataset.ingestBaseUrl(appContext)
        val token = ResearchDataset.ingestToken(appContext)
        if (baseUrl == null || token == null) return snapshot().optInt("pending", 0) > 0
        val preferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        runCatching { request("GET", "$baseUrl/health", token) }
            .onSuccess { (code, _) -> preferences.edit().putString(KEY_SERVER_STATE, if (code in 200..299) "connected" else "unreachable").apply() }
            .onFailure { preferences.edit().putString(KEY_SERVER_STATE, "unreachable").apply() }
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
                    verifyReceipt(resume, metadata, audio.length())
                    markUploaded(metadataFile, audio, metadata, resume)
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
                            verifyReceipt(ack, metadata, audio.length())
                            markUploaded(metadataFile, audio, metadata, ack)
                            preferences.edit().putString(KEY_LAST_SUCCESS, Instant.now().toString())
                                .putString(KEY_SERVER_STATE, "connected").apply()
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
                runCatching { markFailed(metadataFile, metadata, error) }
                preferences.edit().putString(KEY_SERVER_STATE, "unreachable").apply()
                Log.w(TAG, "Upload deferred clip=${metadata.optString("clip_id")}; will retry", error)
            }
        }
        return snapshot().optInt("pending", 0) > 0
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

    private fun verifyReceipt(response: JSONObject, metadata: JSONObject, expectedBytes: Long) {
        check(response.optBoolean("complete", true)) { "server has not completed this upload" }
        check(response.optString("sha256") == metadata.getString("sha256")) { "server checksum does not match local audio" }
        check(response.optLong("bytes", expectedBytes) == expectedBytes) { "server byte count does not match local audio" }
    }

    private fun markUploaded(metadataFile: File, audio: File, metadata: JSONObject, response: JSONObject) {
        metadata.put("upload_status", "uploaded").put("uploaded_at", Instant.now().toString())
            .remove("upload_error")
        val receipt = JSONObject(metadata.toString())
            .put("server_clip_id", response.optString("clip_id"))
            .put("server_path", response.optString("path"))
            .put("server_sha256", response.getString("sha256"))
            .put("server_bytes", response.getLong("bytes"))
            .put("receipt_verified", true)
        writeAtomically(File(receiptsRoot, "${metadata.getString("clip_id")}.json"), receipt)
        val temp = File(metadataFile.parentFile, metadataFile.name + ".tmp")
        temp.delete()
        temp.writeText(metadata.toString(), Charsets.UTF_8)
        check(temp.renameTo(metadataFile))
        check(audio.delete()) { "verified upload receipt saved, but local audio could not be removed" }
        check(metadataFile.delete()) { "verified upload receipt saved, but local sidecar could not be removed" }
    }

    private fun writeAtomically(target: File, value: JSONObject) {
        check(target.parentFile?.mkdirs() == true || target.parentFile?.isDirectory == true)
        val temporary = File(target.parentFile, "${target.name}.tmp")
        FileOutputStream(temporary).use { output ->
            output.write(value.toString().toByteArray(Charsets.UTF_8))
            output.fd.sync()
        }
        check(temporary.renameTo(target)) { "could not save verified upload receipt" }
    }

    private fun markFailed(metadataFile: File, metadata: JSONObject, error: Exception) {
        metadata.put("upload_status", "failed")
            .put("upload_attempts", metadata.optInt("upload_attempts", 0) + 1)
            .put("last_upload_attempt_at", Instant.now().toString())
            .put("upload_error", error.message?.take(240) ?: error.javaClass.simpleName)
        val temp = File(metadataFile.parentFile, metadataFile.name + ".tmp")
        temp.delete()
        temp.writeText(metadata.toString(), Charsets.UTF_8)
        check(temp.renameTo(metadataFile))
    }

    private fun snapshot(): JSONObject {
        val recordedIds = mutableSetOf<String>()
        val uploadedIds = mutableSetOf<String>()
        var pending = 0
        var failed = 0
        var missingMetadata = 0
        var lastSuccess: String? = null
        receiptsRoot.listFiles { file -> file.isFile && file.extension == "json" }?.forEach { receiptFile ->
            val receipt = runCatching { JSONObject(receiptFile.readText(Charsets.UTF_8)) }.getOrNull() ?: return@forEach
            val clipId = receipt.optString("clip_id").takeIf(String::isNotBlank) ?: receiptFile.nameWithoutExtension
            if (receipt.optBoolean("receipt_verified")) {
                recordedIds += clipId
                uploadedIds += clipId
                val time = receipt.optString("uploaded_at").takeIf(String::isNotBlank)
                if (time != null && (lastSuccess == null || time > lastSuccess!!)) lastSuccess = time
            }
        }
        root.walkTopDown().filter { it.isFile && it.extension.equals("wav", ignoreCase = true) }.forEach { audio ->
            val sidecar = File(audio.parentFile, "${audio.nameWithoutExtension}.json")
            if (!sidecar.isFile) {
                recordedIds += audio.relativeTo(root).invariantSeparatorsPath
                missingMetadata++
                pending++
                return@forEach
            }
            val metadata = runCatching { JSONObject(sidecar.readText(Charsets.UTF_8)) }.getOrNull()
            val clipId = metadata?.optString("clip_id")?.takeIf(String::isNotBlank)
                ?: audio.relativeTo(root).invariantSeparatorsPath
            recordedIds += clipId
            when (metadata?.optString("upload_status")) {
                "uploaded" -> {
                    uploadedIds += clipId
                    val time = metadata.optString("uploaded_at").takeIf(String::isNotBlank)
                    if (time != null && (lastSuccess == null || time > lastSuccess!!)) lastSuccess = time
                }
                "failed" -> { failed++; pending++ }
                else -> pending++
            }
        }
        val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val savedLast = prefs.getString(KEY_LAST_SUCCESS, null)
        if (savedLast != null && (lastSuccess == null || savedLast > lastSuccess!!)) lastSuccess = savedLast
        return JSONObject()
            .put("recorded", recordedIds.size)
            .put("uploaded", uploadedIds.size)
            .put("pending", pending)
            .put("failed", failed + missingMetadata)
            .put("missingMetadata", missingMetadata)
            .put("lastSuccessfulUpload", lastSuccess ?: JSONObject.NULL)
            .put("serverStatus", prefs.getString(KEY_SERVER_STATE, "unknown"))
            .put("configured", ResearchDataset.ingestBaseUrl(appContext) != null && ResearchDataset.ingestToken(appContext) != null)
    }

    companion object {
        private const val TAG = "EnergridUploadQueue"
        private const val CHUNK_BYTES = 1024 * 1024
        private const val PREFS = "research-audio-upload-state"
        private const val KEY_LAST_SUCCESS = "last_success"
        private const val KEY_SERVER_STATE = "server_state"
    }
}
