package bg.energrid.home

import android.content.Context
import android.provider.Settings
import android.util.Base64
import org.json.JSONObject
import java.io.File
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
