package bg.energrid.home

import android.content.Context
import android.provider.Settings
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.time.Instant
import java.security.KeyStore
import java.net.URI
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

internal data class SavedSegment(
    val file: File,
    val metadataFile: File,
    val clipId: String,
    val metadata: JSONObject,
)

internal object ResearchDataset {
    private const val KEY_ALIAS = "energrid-audio-ingest-token"
    private const val CONFIG = "research-audio"
    private const val BASE_URL = "ingest_url"
    private const val TOKEN = "ingest_token"

    fun deviceId(context: Context): String = Settings.Secure.getString(
        context.contentResolver, Settings.Secure.ANDROID_ID
    ) ?: "android-device"

    fun saveSegment(
        context: Context,
        file: File,
        category: String,
        sessionId: String,
        startedAt: String,
        endedAt: String,
        recovered: Boolean = false,
    ): SavedSegment {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        val hash = digest.digest().joinToString("") { "%02x".format(it) }
        val dataBytes = (file.length() - 44).coerceAtLeast(0)
        val clipId = "${sessionId}_${file.nameWithoutExtension}"
        val metadata = JSONObject()
            .put("clip_id", clipId)
            .put("timestamp", startedAt)
            .put("started_at", startedAt)
            .put("ended_at", endedAt)
            .put("label", "unlabeled")
            .put("label_source", "none")
            .put("model_version", "")
            .put("confidence_score", JSONObject.NULL)
            .put("duration_seconds", dataBytes / 32000.0)
            .put("sample_rate", 16000)
            .put("channels", 1)
            .put("sample_format", "pcm_s16le")
            .put("device_id", deviceId(context))
            .put("session_id", sessionId)
            .put("category", category)
            .put("recording_environment", category)
            .put("sha256", hash)
            .put("bytes", file.length())
            .put("upload_status", "queued")
            .put("recovered_after_interruption", recovered)
        val metadataFile = File(file.parentFile, "${file.nameWithoutExtension}.json")
        val temp = File(metadataFile.parentFile, metadataFile.name + ".tmp")
        temp.writeText(metadata.toString(), Charsets.UTF_8)
        check(temp.renameTo(metadataFile)) { "Could not finalize segment metadata" }
        return SavedSegment(file, metadataFile, clipId, metadata)
    }

    fun saveLegacySegmentMetadata(
        context: Context,
        file: File,
        category: String,
        sessionId: String,
        startedAt: String,
        endedAt: String,
        recovered: Boolean = false,
    ): SavedSegment = saveSegment(context, file, category, sessionId, startedAt, endedAt, recovered)

    /** Adds sidecars for legacy WAVs without changing their audio bytes or existing metadata. */
    fun reconcileMissingMetadata(context: Context): ReconciliationResult {
        return reconcileDirectory(context, File(context.filesDir, "wakeword-samples"))
    }

    internal fun reconcileDirectory(context: Context, root: File): ReconciliationResult {
        if (!root.isDirectory) return ReconciliationResult(0, 0)
        val manifest = readBackgroundManifest(File(root, "background_manifest.csv"))
        var recovered = 0
        var invalid = 0
        root.walkTopDown().filter { it.isFile && it.extension.equals("wav", ignoreCase = true) }.forEach { audio ->
            val metadataFile = File(audio.parentFile, "${audio.nameWithoutExtension}.json")
            if (metadataFile.exists()) return@forEach
            val metadata = runCatching { recoveredMetadata(context, root, audio, manifest) }.getOrNull()
            if (metadata == null) {
                invalid++
                return@forEach
            }
            val temporary = File(metadataFile.parentFile, "${metadataFile.name}.recovery.tmp")
            runCatching {
                temporary.writeText(metadata.toString(), Charsets.UTF_8)
                if (!metadataFile.exists()) check(temporary.renameTo(metadataFile))
                else temporary.delete()
                if (metadataFile.exists()) recovered++
            }.onFailure { temporary.delete() }
        }
        return ReconciliationResult(recovered, invalid)
    }

    private data class ManifestRecord(
        val fileName: String,
        val category: String,
        val sessionId: String,
        val segment: Int,
        val duration: Double,
    )

    data class ReconciliationResult(val recovered: Int, val invalid: Int)

    private fun readBackgroundManifest(file: File): Map<String, ManifestRecord> {
        if (!file.isFile) return emptyMap()
        return runCatching {
            file.readLines().drop(1).mapNotNull { line ->
                val columns = line.split(',')
                if (columns.size < 5) return@mapNotNull null
                val path = columns[0].substringAfterLast('/')
                val category = columns[1]
                val session = columns[2]
                val segment = columns[3].toIntOrNull() ?: return@mapNotNull null
                val duration = columns[4].toDoubleOrNull() ?: return@mapNotNull null
                path to ManifestRecord(path, category, session, segment, duration)
            }.toMap()
        }.getOrDefault(emptyMap())
    }

    private data class WavFormat(val sampleRate: Int, val channels: Int, val bits: Int, val dataBytes: Long)

    private fun recoveredMetadata(
        context: Context,
        root: File,
        audio: File,
        manifest: Map<String, ManifestRecord>,
    ): JSONObject? {
        val wav = readWavFormat(audio) ?: return null
        if (wav.sampleRate != 16000 || wav.channels != 1 || wav.bits != 16 || wav.dataBytes <= 0) return null
        val duration = wav.dataBytes / (wav.sampleRate.toDouble() * wav.channels * wav.bits / 8.0)
        val digest = MessageDigest.getInstance("SHA-256")
        audio.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        val relative = audio.relativeTo(root).invariantSeparatorsPath
        val row = manifest[audio.name]
        val background = relative.startsWith("negative/") && audio.name.startsWith("background_")
        val inferred = if (background) inferBackgroundIdentity(audio, row, manifest.values) else null
        val sessionId = inferred?.first ?: "unknown"
        val category = when {
            row != null -> row.category
            inferred != null -> inferred.third
            relative.startsWith("positive/") -> "legacy_wake_sample"
            relative.startsWith("negative/") -> "legacy_unspecified"
            else -> "legacy_unspecified"
        }
        val clipId = if (inferred != null) "${sessionId}_${audio.nameWithoutExtension}" else "recovered_${sha.take(32)}"
        val start = when {
            inferred?.second != null -> inferred.second
            else -> epochFromName(audio.nameWithoutExtension)?.let(Instant::ofEpochMilli)?.toString()
        }
        val timestampSource = when {
            inferred?.second != null -> "session_id_epoch_plus_manifest_segment_offsets_estimated"
            start != null -> "epoch_millis_in_filename"
            else -> "unavailable"
        }
        val endedAt = Instant.ofEpochMilli(audio.lastModified()).toString()
        return JSONObject()
            .put("clip_id", clipId)
            .put("timestamp", start ?: JSONObject.NULL)
            .put("started_at", start ?: "unknown")
            .put("ended_at", endedAt)
            .put("ended_at_source", "filesystem_modification_time")
            .put("timestamp_source", timestampSource)
            .put("timestamp_precision", if (timestampSource.contains("estimated")) "estimated" else if (start == null) "unknown" else "filename_or_session")
            .put("label", "unlabeled")
            .put("label_source", "none")
            .put("model_version", "")
            .put("confidence_score", JSONObject.NULL)
            .put("duration_seconds", duration)
            .put("sample_rate", wav.sampleRate)
            .put("channels", wav.channels)
            .put("sample_format", "pcm_s16le")
            .put("device_id", deviceId(context))
            .put("session_id", sessionId)
            .put("session_id_source", if (sessionId == "unknown") "unavailable" else "filename_and_manifest")
            .put("category", category)
            .put("recording_environment", if (background) category else "unknown")
            .put("sha256", sha)
            .put("bytes", audio.length())
            .put("upload_status", "queued")
            .put("recovered_metadata", true)
            .put("metadata_source", if (row != null) "background_manifest_filename_and_wav" else "filename_path_and_wav")
            .put("source_file", relative)
            .put("manifest_duration_seconds", row?.duration ?: JSONObject.NULL)
    }

    private fun inferBackgroundIdentity(
        audio: File,
        row: ManifestRecord?,
        manifest: Collection<ManifestRecord>,
    ): Triple<String, String?, String>? {
        if (row != null) {
            val start = sessionSegmentStart(row, manifest)
            return Triple(row.sessionId, start, row.category)
        }
        val category = audio.parentFile?.name ?: return null
        val prefix = "background_${category}_"
        if (!audio.nameWithoutExtension.startsWith(prefix)) return null
        val suffix = audio.nameWithoutExtension.substringAfterLast('_', "")
        val segment = suffix.toIntOrNull() ?: return null
        val session = audio.nameWithoutExtension.removePrefix(prefix).substringBeforeLast('_')
        return Triple(session, sessionEpoch(session)?.let(Instant::ofEpochMilli)?.toString(), category).also { require(segment > 0) }
    }

    private fun sessionSegmentStart(record: ManifestRecord, manifest: Collection<ManifestRecord>): String? {
        val sessionStart = sessionEpoch(record.sessionId) ?: return null
        return runCatching {
            val priorSeconds = manifest.filter {
                it.sessionId == record.sessionId && it.category == record.category && it.segment < record.segment
            }.sumOf { it.duration }
            Instant.ofEpochMilli(sessionStart + (priorSeconds * 1000).toLong()).toString()
        }.getOrNull()
    }

    private fun sessionEpoch(value: String): Long? = value.toLongOrNull()?.takeIf { it in 1_600_000_000_000L..2_200_000_000_000L }

    private fun epochFromName(name: String): Long? = name.substringAfterLast('_').toLongOrNull()
        ?.takeIf { it in 1_600_000_000_000L..2_200_000_000_000L }

    private fun readWavFormat(file: File): WavFormat? = runCatching {
        RandomAccessFile(file, "r").use { input ->
            if (input.length() < 44) return null
            val header = ByteArray(44)
            input.readFully(header)
            if (String(header, 0, 4, Charsets.US_ASCII) != "RIFF" || String(header, 8, 4, Charsets.US_ASCII) != "WAVE" || String(header, 36, 4, Charsets.US_ASCII) != "data") return null
            fun intLE(offset: Int): Int = (header[offset].toInt() and 0xff) or
                ((header[offset + 1].toInt() and 0xff) shl 8) or
                ((header[offset + 2].toInt() and 0xff) shl 16) or
                ((header[offset + 3].toInt() and 0xff) shl 24)
            fun shortLE(offset: Int): Int = (header[offset].toInt() and 0xff) or ((header[offset + 1].toInt() and 0xff) shl 8)
            val dataBytes = intLE(40).toLong() and 0xffffffffL
            if (dataBytes + 44L != file.length()) return null
            WavFormat(intLE(24), shortLE(22), shortLE(34), dataBytes)
        }
    }.getOrNull()

    fun configure(context: Context, baseUrl: String, token: String) {
        require(baseUrl.startsWith("http://") || baseUrl.startsWith("https://")) { "Use an HTTP(S) LAN address" }
        require(token.length >= 24) { "Authentication token must be at least 24 characters" }
        val host = URI(baseUrl).host?.lowercase() ?: throw IllegalArgumentException("Server URL needs a host")
        val octets = host.split('.').mapNotNull { it.toIntOrNull() }
        val privateIpv4 = octets.size == 4 && (
            octets[0] == 10 ||
                (octets[0] == 172 && octets[1] in 16..31) ||
                (octets[0] == 192 && octets[1] == 168) ||
                (octets[0] == 127 && octets[1] == 0)
            )
        require(privateIpv4 || host.endsWith(".local")) { "Use a private LAN IPv4 address or .local hostname; public hosts are blocked" }
        val encrypted = encrypt(token)
        context.getSharedPreferences(CONFIG, Context.MODE_PRIVATE).edit()
            .putString(BASE_URL, baseUrl.trimEnd('/'))
            .putString(TOKEN, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .apply()
    }

    fun ingestBaseUrl(context: Context): String? = context.getSharedPreferences(CONFIG, Context.MODE_PRIVATE)
        .getString(BASE_URL, null)

    fun ingestToken(context: Context): String? = runCatching {
        val value = context.getSharedPreferences(CONFIG, Context.MODE_PRIVATE).getString(TOKEN, null) ?: return null
        decrypt(Base64.decode(value, Base64.NO_WRAP))
    }.getOrNull()

    fun clearConfiguration(context: Context) {
        context.getSharedPreferences(CONFIG, Context.MODE_PRIVATE).edit().clear().apply()
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
    }

    private fun encrypt(value: String): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        return cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    }

    private fun decrypt(value: ByteArray): String {
        require(value.size > 12) { "Encrypted token is invalid" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, value.copyOfRange(0, 12)))
        return String(cipher.doFinal(value.copyOfRange(12, value.size)), Charsets.UTF_8)
    }

    private fun secretKey(): SecretKey {
        val store = keyStore()
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(
            KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return generator.generateKey()
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
}
