package bg.energrid.home

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import com.openwakeword.OpenWakeWord
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

internal class WakeWordController(
    context: Context,
    private val listener: Listener,
) {
    interface Listener {
        fun onStatus(status: String)
        fun onWakeWordDetected()
        fun onCommandAudio(pcm16: ByteArray)
        fun onCommandEnded()
        fun onSamplesChanged(status: String, positive: Int, negative: Int)
        fun onSegmentSaved(segment: SavedSegment) = Unit
    }

    enum class State {
        DISABLED,
        MODEL_MISSING,
        LISTENING,
        WAITING_FOR_COMMAND,
        CAPTURING_COMMAND,
        WAITING_FOR_ASSISTANT,
        RECORDING_SAMPLE,
        ERROR,
    }

    private val appContext = context.applicationContext
    private val stopping = AtomicBoolean(false)
    private val stopSample = AtomicBoolean(false)
    @Volatile private var state = State.DISABLED
    @Volatile private var enabled = false
    @Volatile private var detector: OpenWakeWord? = null
    @Volatile private var worker: Thread? = null
    @Volatile private var activeRecorder: AudioRecord? = null
    @Volatile private var commandReady = false
    @Volatile private var manualCapture = false

    private val samplesDirectory get() = File(appContext.filesDir, SAMPLE_DIRECTORY)
    private val modelFile get() = File(appContext.filesDir, MODEL_FILE)

    fun currentState(): State = state

    @Synchronized
    fun setEnabled(value: Boolean): State {
        enabled = value
        if (!value) {
            stopAll()
            setState(State.DISABLED)
        } else startWakeDetection()
        return state
    }

    @Synchronized
    fun startWakeDetection() {
        if (!enabled || state == State.WAITING_FOR_ASSISTANT || state == State.CAPTURING_COMMAND ||
            state == State.RECORDING_SAMPLE) return
        if (!modelFile.isFile) {
            setState(State.MODEL_MISSING)
            Log.i(TAG, "Custom Energrid wake model missing at ${modelFile.path}; microphone remains closed")
            return
        }
        if (detector != null || worker?.isAlive == true) return

        stopping.set(false)
        worker = thread(name = "energrid-wake-model-init", isDaemon = true) {
            try {
                val instance = OpenWakeWord.Builder(appContext)
                    .setModelBytes(modelFile.readBytes())
                    .setThreshold(WAKE_THRESHOLD)
                    .setDebounceMs(DEBOUNCE_MS)
                    .build()
                if (stopping.get() || !enabled) {
                    instance.release()
                    return@thread
                }
                detector = instance
                setState(State.LISTENING)
                Log.i(TAG, "Offline Energrid wake detector started (openWakeWord, 16 kHz mono)")
                instance.start { score ->
                    if (!enabled || stopping.get() || state != State.LISTENING || score < WAKE_THRESHOLD) return@start
                    Log.i(TAG, "Energrid wake phrase detected score=$score")
                    commandReady = false
                    setState(State.WAITING_FOR_COMMAND)
                    stopDetector()
                    listener.onWakeWordDetected()
                    launchCommandCapture()
                }
            } catch (error: Exception) {
                Log.e(TAG, "Offline wake detector initialization failed", error)
                setState(State.ERROR)
            } finally {
                synchronized(this) { worker = null }
            }
        }
    }

    @Synchronized
    fun beginCommandCapture() {
        if (!enabled) return
        commandReady = true
    }

    @Synchronized
    fun startManualCommandCapture(): Boolean {
        if (state == State.RECORDING_SAMPLE || state == State.CAPTURING_COMMAND) return false
        stopDetector()
        stopping.set(false)
        commandReady = true
        manualCapture = true
        setState(State.CAPTURING_COMMAND)
        launchCommandCapture()
        Log.i(TAG, "Manual Hold-to-talk capture started")
        return true
    }

    @Synchronized
    fun endManualCommandCapture() {
        if (!manualCapture) return
        Log.i(TAG, "Manual Hold-to-talk capture released")
        stopping.set(true)
        activeRecorder?.let { runCatching { it.stop() } }
        worker?.interrupt()
    }

    @Synchronized
    fun assistantTurnFinished() {
        commandReady = false
        stopCommandCapture()
        if (enabled) {
            setState(State.WAITING_FOR_COMMAND)
            startWakeDetection()
        } else setState(State.DISABLED)
    }

    @Synchronized
    fun startSampleRecording(label: String, sessionId: String = System.currentTimeMillis().toString()) {
        if (label == "background:tv" || label == "background:english_tv" || label == "background:conversation" ||
            label == "background:household" || label == "background:mixed") {
            startBackgroundRecording(label.substringAfter(':'), sessionId)
            return
        }
        if (label != "positive" && label != "negative") return
        if (state == State.RECORDING_SAMPLE) return
        stopDetector()
        stopCommandCapture()
        stopSample.set(false)
        setState(State.RECORDING_SAMPLE)
        notifySamples("recording")
        worker = thread(name = "energrid-wake-sample", isDaemon = true) { recordSample(label) }
    }

    fun stopSampleRecording() {
        stopSample.set(true)
        if (state == State.RECORDING_SAMPLE) {
            activeRecorder?.let { recorder ->
                runCatching {
                    if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
                }.onFailure { Log.w(TAG, "Could not interrupt background sample read", it) }
            }
        }
    }

    @Synchronized
    private fun startBackgroundRecording(category: String, sessionId: String) {
        if (state == State.RECORDING_SAMPLE) return
        stopDetector()
        stopCommandCapture()
        stopSample.set(false)
        recoverInterruptedSegments()
        setState(State.RECORDING_SAMPLE)
        notifySamples("recording")
        worker = thread(name = "energrid-wake-background", isDaemon = true) { recordBackground(category, sessionId) }
    }

    fun sampleCountsJson(): String = """{"positive":${sampleCount("positive")},"negative":${sampleCount("negative")},"status":"${if (state == State.RECORDING_SAMPLE) "recording" else "idle"}"}"""

    fun reviewSegmentsJson(): String {
        val clips = samplesDirectory.walkTopDown()
            .filter { it.isFile && it.extension == "json" && !it.name.endsWith(".part.json") }
            .mapNotNull { file -> runCatching { org.json.JSONObject(file.readText(Charsets.UTF_8)) }.getOrNull() }
            .filter { it.has("clip_id") }
            .sortedByDescending { it.optString("started_at") }
        val array = org.json.JSONArray()
        clips.forEach { array.put(it) }
        val labels = listOf("confirmed_positive", "confirmed_negative", "uncertain", "unlabeled")
        val counts = org.json.JSONObject()
        for (label in labels) counts.put(label, clips.count { it.optString("label", "unlabeled") == label })
        return org.json.JSONObject().put("clips", array).put("counts", counts).toString()
    }

    fun reviewAudioFile(clipId: String): File? = findClipMetadata(clipId)?.let { metadataFile ->
        File(metadataFile.parentFile, metadataFile.nameWithoutExtension + ".wav").takeIf { it.isFile }
    }

    @Synchronized
    fun labelClip(clipId: String, label: String, occurrencesJson: String): Boolean {
        if (label !in setOf("confirmed_positive", "confirmed_negative", "uncertain", "unlabeled")) return false
        val file = findClipMetadata(clipId) ?: return false
        return runCatching {
            val metadata = org.json.JSONObject(file.readText(Charsets.UTF_8))
            val occurrences = org.json.JSONArray(occurrencesJson)
            val duration = metadata.optDouble("duration_seconds", 0.0)
            val checked = (0 until occurrences.length()).map { index ->
                (occurrences.opt(index) as? Number)?.toDouble() ?: error("Occurrence must be seconds")
            }
            require(checked.all { it.isFinite() && it >= 0 && it <= duration } && checked.distinct().size == checked.size)
            metadata
                .put("label", label)
                .put("label_source", if (label == "unlabeled") "none" else "human_review")
                .put("reviewed_at", java.time.Instant.now().toString())
                .put("wake_word_occurrences", org.json.JSONArray(checked.sorted()))
            val temp = File(file.parentFile, file.name + ".tmp")
            temp.writeText(metadata.toString(), Charsets.UTF_8)
            check(temp.renameTo(file))
            true
        }.getOrDefault(false)
    }

    @Synchronized
    fun deleteClip(clipId: String): Boolean {
        val metadataFile = findClipMetadata(clipId) ?: return false
        val audioFile = File(metadataFile.parentFile, metadataFile.nameWithoutExtension + ".wav")
        val deletedAudio = !audioFile.exists() || audioFile.delete()
        val deletedMetadata = metadataFile.delete()
        return deletedAudio && deletedMetadata
    }

    private fun findClipMetadata(clipId: String): File? {
        if (clipId.isBlank() || clipId.any { !(it.isLetterOrDigit() || it == '_' || it == '-') }) return null
        return samplesDirectory.walkTopDown().firstOrNull { file ->
            file.isFile && file.extension == "json" && !file.name.endsWith(".part.json") &&
                runCatching { org.json.JSONObject(file.readText(Charsets.UTF_8)).optString("clip_id") == clipId }.getOrDefault(false)
        }
    }

    fun exportSamples(): File {
        val exportDirectory = File(appContext.cacheDir, "wake-samples").apply { mkdirs() }
        val export = File(exportDirectory, "energrid-wakeword-samples.zip")
        java.util.zip.ZipOutputStream(FileOutputStream(export)).use { zip ->
            samplesDirectory.walkTopDown().filter { it.isFile && it.extension == "wav" }.forEach { file ->
                val relative = file.relativeTo(samplesDirectory).invariantSeparatorsPath
                zip.putNextEntry(java.util.zip.ZipEntry(relative))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
            samplesDirectory.walkTopDown().filter { it.isFile && (it.extension == "csv" || (it.extension == "json" && !it.name.endsWith(".part.json"))) }.forEach { file ->
                val relative = file.relativeTo(samplesDirectory).invariantSeparatorsPath
                zip.putNextEntry(java.util.zip.ZipEntry(relative))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
            zip.putNextEntry(java.util.zip.ZipEntry("README.txt"))
            zip.write("Energrid offline wake-word samples. Background WAV parts are five-minute segments; parts with the same session_id belong together and must stay in one data split. Positive clips recorded on the same local date share a session_id. All recording is local, 16 kHz mono PCM.\n".toByteArray())
            zip.closeEntry()
        }
        return export
    }

    @Synchronized
    fun stop() {
        enabled = false
        commandReady = false
        stopAll()
        setState(State.DISABLED)
    }

    private fun recordSample(label: String) {
        var recorder: AudioRecord? = null
        val pcm = ByteArrayOutputStream()
        try {
            recorder = createRecorder()
            activeRecorder = recorder
            recorder.startRecording()
            val frame = ShortArray(FRAME_SAMPLES)
            val startedAt = System.currentTimeMillis()
            val maximumDuration = if (label == "positive") MAX_POSITIVE_SAMPLE_MS else MAX_NEGATIVE_SAMPLE_MS
            while (!stopSample.get() && System.currentTimeMillis() - startedAt < maximumDuration) {
                val count = recorder.read(frame, 0, frame.size)
                if (count <= 0) continue
                for (index in 0 until count) {
                    val value = frame[index].toInt()
                    pcm.write(value and 0xff)
                    pcm.write((value shr 8) and 0xff)
                }
            }
            if (pcm.size() >= MIN_SAMPLE_BYTES) {
                val folder = File(samplesDirectory, label).apply { mkdirs() }
                val output = File(folder, "${label}_${System.currentTimeMillis()}.wav")
                FileOutputStream(output).use { stream -> writeWav(stream, pcm.toByteArray()) }
                if (label == "positive") appendPositiveManifest(output)
                Log.i(TAG, "Saved local $label wake sample (${pcm.size()} bytes): ${output.name}")
                notifySamples("saved")
            } else notifySamples("too_short")
        } catch (error: Exception) {
            Log.e(TAG, "Wake sample recording failed", error)
            notifySamples("error")
        } finally {
            activeRecorder = null
            releaseRecorder(recorder)
            synchronized(this) {
                worker = null
                setState(if (enabled) State.MODEL_MISSING else State.DISABLED)
                if (enabled) startWakeDetection()
            }
        }
    }

    private fun recordBackground(category: String, sessionId: String) {
        var recorder: AudioRecord? = null
        var segmentIndex = 0
        var segmentBytes = 0
        var segmentFile: File? = null
        var output: RandomAccessFile? = null
        var segmentStartedAt = 0L
        var stopStatus = "saved"
        val frame = ShortArray(FRAME_SAMPLES)
        try {
            val folder = File(samplesDirectory, "negative/$category").apply { mkdirs() }
            val prefix = "background_${category}_${sessionId}_"
            segmentIndex = (folder.listFiles()?.count {
                it.isFile && it.name.startsWith(prefix) && (it.name.endsWith(".wav") || it.name.endsWith(".wav.part"))
            } ?: 0)
            recorder = createRecorder()
            activeRecorder = recorder
            recorder.startRecording()
            Log.i(TAG, "Started local background capture category=$category session=$sessionId")
            while (!stopSample.get()) {
                if (output == null || segmentBytes >= BACKGROUND_SEGMENT_BYTES) {
                    output?.let { finishBackgroundSegment(it, segmentFile, segmentBytes, category, sessionId, segmentIndex, segmentStartedAt) }
                    output = null
                    if (!withinStorageLimits()) {
                        Log.e(TAG, "Research recording stopped at local storage limit; queued audio was preserved")
                        stopStatus = "storage_limit"
                        break
                    }
                    segmentIndex += 1
                    segmentBytes = 0
                    segmentStartedAt = System.currentTimeMillis()
                    segmentFile = File(folder, "${prefix}${segmentIndex.toString().padStart(4, '0')}.wav.part")
                    File(segmentFile!!.path + ".json").writeText(
                        org.json.JSONObject()
                            .put("category", category)
                            .put("session_id", sessionId)
                            .put("started_at", java.time.Instant.ofEpochMilli(segmentStartedAt).toString())
                            .toString(),
                        Charsets.UTF_8,
                    )
                    output = RandomAccessFile(segmentFile, "rw").apply {
                        setLength(0)
                        write(ByteArray(44))
                    }
                }
                val count = recorder.read(frame, 0, frame.size)
                if (count <= 0) continue
                for (index in 0 until count) {
                    val value = frame[index].toInt()
                    output.write(value and 0xff)
                    output.write((value shr 8) and 0xff)
                }
                segmentBytes += count * 2
            }
            output?.let { finishBackgroundSegment(it, segmentFile, segmentBytes, category, sessionId, segmentIndex, segmentStartedAt) }
            Log.i(TAG, "Finished local background capture category=$category session=$sessionId segments=$segmentIndex")
            notifySamples(stopStatus)
        } catch (error: Exception) {
            Log.e(TAG, "Background wake sample recording failed", error)
            notifySamples("error")
        } finally {
            runCatching { output?.close() }
            activeRecorder = null
            releaseRecorder(recorder)
            synchronized(this) {
                worker = null
                setState(if (enabled) State.MODEL_MISSING else State.DISABLED)
                if (enabled) startWakeDetection()
            }
        }
    }

    private fun finishBackgroundSegment(
        output: RandomAccessFile,
        file: File?,
        dataSize: Int,
        category: String,
        sessionId: String,
        segmentIndex: Int,
        segmentStartedAt: Long,
    ) {
        if (file == null) return
        if (dataSize < MIN_BACKGROUND_SEGMENT_BYTES) {
            output.close()
            file.delete()
            File(file.path + ".json").delete()
            return
        }
        output.seek(0)
        writeWavHeader(output, dataSize)
        output.close()
        val finalized = File(file.parentFile, file.name.removeSuffix(".part").replace(".wav", "") + ".wav")
        check(file.renameTo(finalized)) { "Could not atomically finalize audio segment ${file.name}" }
        val started = java.time.Instant.ofEpochMilli(segmentStartedAt).toString()
        val ended = java.time.Instant.now().toString()
        val saved = ResearchDataset.saveSegment(appContext, finalized, category, sessionId, started, ended)
        File(file.path + ".json").delete()
        FileOutputStream(File(samplesDirectory, "background_manifest.csv"), true).bufferedWriter().use {
            if (File(samplesDirectory, "background_manifest.csv").length() == 0L) {
                it.appendLine("file,category,session_id,segment,duration_seconds")
            }
            it.appendLine("negative/$category/${finalized.name},$category,$sessionId,$segmentIndex,${dataSize / (SAMPLE_RATE * 2.0)}")
        }
        listener.onSegmentSaved(saved)
        Log.i(TAG, "Finalized segment=${finalized.name} bytes=${finalized.length()} sha256=${saved.metadata.optString("sha256")}")
    }

    private fun withinStorageLimits(): Boolean {
        val used = samplesDirectory.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        val free = samplesDirectory.usableSpace
        return used < MAX_LOCAL_DATA_BYTES && free > MIN_FREE_STORAGE_BYTES
    }

    private fun recoverInterruptedSegments() {
        val partials = samplesDirectory.walkTopDown().filter { it.isFile && it.name.endsWith(".wav.part") }.toList()
        for (partial in partials) {
            val dataBytes = ((partial.length() - 44).coerceAtLeast(0) / 2 * 2).toInt()
            val detailsFile = File(partial.path + ".json")
            runCatching {
                if (dataBytes < MIN_BACKGROUND_SEGMENT_BYTES) {
                    partial.delete()
                    detailsFile.delete()
                    return@runCatching
                }
                RandomAccessFile(partial, "rw").use { output ->
                    output.setLength(44L + dataBytes)
                    output.seek(0)
                    writeWavHeader(output, dataBytes)
                }
                val details = org.json.JSONObject(detailsFile.readText(Charsets.UTF_8))
                val finalized = File(partial.parentFile, partial.name.removeSuffix(".part"))
                check(partial.renameTo(finalized)) { "Could not recover interrupted WAV segment" }
                val saved = ResearchDataset.saveSegment(
                    appContext, finalized, details.getString("category"), details.getString("session_id"),
                    details.getString("started_at"), java.time.Instant.ofEpochMilli(partial.lastModified()).toString(), true,
                )
                detailsFile.delete()
                listener.onSegmentSaved(saved)
                Log.w(TAG, "Recovered interrupted WAV ${finalized.name} bytes=${finalized.length()}")
            }.onFailure { error ->
                Log.e(TAG, "Could not recover partial segment ${partial.name}", error)
            }
        }
    }

    private fun appendPositiveManifest(file: File) {
        val manifest = File(samplesDirectory, "positive_manifest.csv")
        val sessionId = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
        FileOutputStream(manifest, true).bufferedWriter().use {
            if (manifest.length() == 0L) it.appendLine("file,session_id")
            it.appendLine("positive/${file.name},$sessionId")
        }
    }

    private fun notifySamples(status: String) = listener.onSamplesChanged(status, sampleCount("positive"), sampleCount("negative"))

    private fun sampleCount(label: String): Int = File(samplesDirectory, label).walkTopDown().count { it.isFile && it.extension == "wav" }

    private fun writeWav(output: FileOutputStream, pcm: ByteArray) {
        val dataSize = pcm.size
        val header = ByteArray(44)
        fun ascii(offset: Int, value: String) { value.toByteArray(Charsets.US_ASCII).copyInto(header, offset) }
        fun littleInt(offset: Int, value: Int) { for (i in 0..3) header[offset + i] = (value shr (8 * i)).toByte() }
        fun littleShort(offset: Int, value: Int) { header[offset] = value.toByte(); header[offset + 1] = (value shr 8).toByte() }
        ascii(0, "RIFF"); littleInt(4, 36 + dataSize); ascii(8, "WAVE"); ascii(12, "fmt ")
        littleInt(16, 16); littleShort(20, 1); littleShort(22, 1); littleInt(24, SAMPLE_RATE)
        littleInt(28, SAMPLE_RATE * 2); littleShort(32, 2); littleShort(34, 16); ascii(36, "data"); littleInt(40, dataSize)
        output.write(header); output.write(pcm)
    }

    private fun writeWavHeader(output: RandomAccessFile, dataSize: Int) {
        val header = ByteArray(44)
        fun ascii(offset: Int, value: String) { value.toByteArray(Charsets.US_ASCII).copyInto(header, offset) }
        fun littleInt(offset: Int, value: Int) { for (i in 0..3) header[offset + i] = (value shr (8 * i)).toByte() }
        fun littleShort(offset: Int, value: Int) { header[offset] = value.toByte(); header[offset + 1] = (value shr 8).toByte() }
        ascii(0, "RIFF"); littleInt(4, 36 + dataSize); ascii(8, "WAVE"); ascii(12, "fmt ")
        littleInt(16, 16); littleShort(20, 1); littleShort(22, 1); littleInt(24, SAMPLE_RATE)
        littleInt(28, SAMPLE_RATE * 2); littleShort(32, 2); littleShort(34, 16); ascii(36, "data"); littleInt(40, dataSize)
        output.write(header)
    }

    private fun launchCommandCapture() {
        stopping.set(false)
        worker = thread(name = "energrid-voice-command", isDaemon = true) { runCommandCapture() }
    }

    private fun runCommandCapture() {
        var recorder: AudioRecord? = null
        try {
            recorder = createRecorder()
            activeRecorder = recorder
            recorder.startRecording()
            setState(State.CAPTURING_COMMAND)
            Log.i(TAG, "Capturing one assistant command; wake audio was not sent to the server")
            val buffer = ShortArray(FRAME_SAMPLES)
            var speechStartedAt = 0L
            var lastSpeechAt = 0L
            val startedAt = System.currentTimeMillis()
            val pendingPcm = ArrayDeque<ByteArray>()
            var pendingBytes = 0
            while (!stopping.get() && (enabled || manualCapture)) {
                val count = recorder.read(buffer, 0, buffer.size)
                if (count <= 0) continue
                val now = System.currentTimeMillis()
                if (rootMeanSquare(buffer, count) >= SPEECH_RMS_THRESHOLD) {
                    if (speechStartedAt == 0L) speechStartedAt = now
                    lastSpeechAt = now
                }
                if (speechStartedAt > 0L) {
                    val frame = toPcm16(buffer, count)
                    if (commandReady) {
                        while (pendingPcm.isNotEmpty()) listener.onCommandAudio(pendingPcm.removeFirst())
                        pendingBytes = 0
                        listener.onCommandAudio(frame)
                    } else {
                        pendingPcm.addLast(frame)
                        pendingBytes += frame.size
                        while (pendingBytes > MAX_PENDING_COMMAND_BYTES && pendingPcm.isNotEmpty()) pendingBytes -= pendingPcm.removeFirst().size
                    }
                    if (!manualCapture && now - lastSpeechAt >= END_OF_SPEECH_MS) {
                        setState(State.WAITING_FOR_ASSISTANT)
                        listener.onCommandEnded()
                        return
                    }
                } else if (!manualCapture && now - startedAt >= EMPTY_COMMAND_TIMEOUT_MS) {
                    setState(State.WAITING_FOR_COMMAND)
                    listener.onCommandEnded()
                    return
                }
            }
        } catch (error: Exception) {
            Log.e(TAG, "Command capture failed", error)
            setState(State.ERROR)
            if (!manualCapture) listener.onCommandEnded()
        } finally {
            activeRecorder = null
            releaseRecorder(recorder)
            val wasManualCapture = manualCapture
            manualCapture = false
            commandReady = false
            if (wasManualCapture) {
                setState(State.WAITING_FOR_ASSISTANT)
                listener.onCommandEnded()
            }
            synchronized(this) {
                worker = null
                if (enabled && state == State.WAITING_FOR_COMMAND) startWakeDetection()
            }
        }
    }

    private fun stopAll() {
        stopping.set(true)
        stopSample.set(true)
        stopDetector()
        stopCommandCapture()
        worker?.interrupt()
        worker = null
    }

    private fun stopDetector() {
        val current = detector
        detector = null
        if (current != null) runCatching { current.stop(); current.release() }
    }

    private fun stopCommandCapture() {
        stopping.set(true)
        activeRecorder?.let { runCatching { it.stop() } }
        worker?.interrupt()
        worker = null
    }

    private fun createRecorder(): AudioRecord {
        val minimumBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimumBuffer > 0) { "AudioRecord does not support 16 kHz mono PCM" }
        return AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT, maxOf(minimumBuffer, FRAME_SAMPLES * 2 * 4))
            .also { check(it.state == AudioRecord.STATE_INITIALIZED) { "Microphone initialization failed" } }
    }

    private fun releaseRecorder(recorder: AudioRecord?) {
        if (recorder == null) return
        runCatching { if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop() }
        runCatching { recorder.release() }
    }

    private fun setState(value: State) {
        state = value
        listener.onStatus(value.name.lowercase(Locale.ROOT))
        Log.i(TAG, "State=${value.name.lowercase(Locale.ROOT)}")
    }

    private fun rootMeanSquare(samples: ShortArray, count: Int): Double {
        var sum = 0.0
        for (index in 0 until count) { val value = samples[index] / 32768.0; sum += value * value }
        return kotlin.math.sqrt(sum / count)
    }

    private fun toPcm16(samples: ShortArray, count: Int): ByteArray {
        val bytes = ByteArray(count * 2)
        for (index in 0 until count) {
            val sample = samples[index].toInt(); bytes[index * 2] = sample.toByte(); bytes[index * 2 + 1] = (sample shr 8).toByte()
        }
        return bytes
    }

    companion object {
        private const val TAG = "EnergridWakeWord"
        private const val SAMPLE_DIRECTORY = "wakeword-samples"
        private const val MODEL_FILE = "wakeword-energrid.onnx"
        private const val SAMPLE_RATE = 16_000
        private const val FRAME_SAMPLES = 1_280
        private const val WAKE_THRESHOLD = 0.5f
        private const val DEBOUNCE_MS = 2_000L
        private const val SPEECH_RMS_THRESHOLD = 0.012
        private const val END_OF_SPEECH_MS = 1_500L
        private const val EMPTY_COMMAND_TIMEOUT_MS = 12_000L
        private const val MAX_PENDING_COMMAND_BYTES = 96_000
        private const val MAX_POSITIVE_SAMPLE_MS = 8_000L
        private const val MAX_NEGATIVE_SAMPLE_MS = 60_000L
        private const val MIN_SAMPLE_BYTES = 8_000
        private const val BACKGROUND_SEGMENT_BYTES = SAMPLE_RATE * 2 * 300
        private const val MIN_BACKGROUND_SEGMENT_BYTES = SAMPLE_RATE * 2
        private const val MAX_LOCAL_DATA_BYTES = 2L * 1024 * 1024 * 1024
        private const val MIN_FREE_STORAGE_BYTES = 256L * 1024 * 1024
    }
}
