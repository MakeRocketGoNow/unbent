package app.unbent.android.share

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One shared file, already copied somewhere this app controls. */
data class StagedFile(
    val file: File,
    val filename: String,
    val contentType: String,
)

/**
 * Copies shared content out of the sending app and into our cache.
 *
 * This has to happen before the share activity finishes. The URI permission that comes with
 * a share is tied to the receiving activity's lifetime, so a worker that starts later finds
 * the grant revoked and reads nothing. Copying first costs a little disk and makes the
 * upload retryable, which matters on a phone radio.
 */
object Staging {

    /** HEIC is what an iPhone-era Android camera hands over, and browsers cannot show it. */
    private val HEIF_TYPES = setOf("image/heic", "image/heif", "image/heic-sequence")

    fun stageAll(context: Context, uris: List<Uri>, jobId: String): List<StagedFile> {
        val dir = jobDir(context, jobId).apply { mkdirs() }
        val used = mutableSetOf<String>()
        return uris.mapIndexedNotNull { index, uri ->
            runCatching { stageOne(context, uri, dir, index, used) }.getOrNull()
        }
    }

    private fun stageOne(
        context: Context,
        uri: Uri,
        dir: File,
        index: Int,
        used: MutableSet<String>,
    ): StagedFile {
        val resolver = context.contentResolver
        val declaredType = resolver.getType(uri) ?: "application/octet-stream"
        val displayName = queryDisplayName(resolver, uri)

        val isHeif = declaredType.lowercase(Locale.ROOT).substringBefore(';') in HEIF_TYPES

        val baseName = sanitize(displayName, index, if (isHeif) "jpg" else extensionFor(declaredType))
        val filename = uniquify(baseName, used)
        val target = File(dir, filename)

        if (isHeif) {
            // Transcode rather than upload: the server serves only an allowlist of image
            // types inline, HEIC is not on it, and Chrome cannot render it anyway. A shared
            // photo has to appear in the note, not download as an opaque blob.
            val source = ImageDecoder.createSource(resolver, uri)
            val bitmap = ImageDecoder.decodeBitmap(source) { decoder, _, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.isMutableRequired = false
            }
            target.outputStream().use { out ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
            }
            bitmap.recycle()
            return StagedFile(target, filename, "image/jpeg")
        }

        resolver.openInputStream(uri)?.use { input ->
            target.outputStream().use { output -> input.copyTo(output) }
        } ?: throw IllegalStateException("Could not open $uri")

        return StagedFile(target, filename, declaredType.substringBefore(';').trim())
    }

    private fun queryDisplayName(resolver: ContentResolver, uri: Uri): String? =
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { c ->
                    if (c.moveToFirst()) {
                        val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (i >= 0) c.getString(i) else null
                    } else null
                }
        }.getOrNull()

    /**
     * Forces a name the API will accept.
     *
     * The server rejects path separators, `.`/`..`, and leading dots (filenameSchema), and a
     * rejected name loses the file for a reason the user cannot act on. Names arriving from
     * other apps are arbitrary — sometimes absent, sometimes a whole path.
     */
    fun sanitize(raw: String?, index: Int, fallbackExtension: String): String {
        val candidate = raw
            ?.substringAfterLast('/')
            ?.substringAfterLast('\\')
            ?.replace(Regex("[\\x00-\\x1f]"), "")
            ?.trim()
            ?.trimStart('.')
            .orEmpty()

        if (candidate.isNotEmpty() && candidate != "." && candidate != "..") {
            val named = if (candidate.contains('.')) candidate else "$candidate.$fallbackExtension"
            return capLength(named)
        }
        return "capture-${index + 1}.$fallbackExtension"
    }

    /**
     * Bounds the whole name, extension included.
     *
     * The API caps a filename at 255 characters, and truncating the stem while keeping the
     * suffix means a 400-character name from another app still arrives as something the
     * server accepts and the user can recognise.
     */
    private fun capLength(name: String, max: Int = 200): String {
        if (name.length <= max) return name
        val ext = name.substringAfterLast('.', "")
        if (ext.isEmpty() || ext.length > 12) return name.take(max)
        return name.substringBeforeLast('.').take(max - ext.length - 1) + "." + ext
    }

    /** Distinct names within one share, so two "image.jpg" do not collide in the cache dir. */
    private fun uniquify(name: String, used: MutableSet<String>): String {
        if (used.add(name)) return name
        val stem = name.substringBeforeLast('.', name)
        val ext = name.substringAfterLast('.', "")
        var n = 2
        while (true) {
            val candidate = if (ext.isEmpty()) "$stem-$n" else "$stem-$n.$ext"
            if (used.add(candidate)) return candidate
            n++
        }
    }

    private fun extensionFor(mime: String): String = when (mime.substringBefore(';').trim()) {
        "image/jpeg" -> "jpg"
        "image/png" -> "png"
        "image/gif" -> "gif"
        "image/webp" -> "webp"
        "application/pdf" -> "pdf"
        "text/plain" -> "txt"
        else -> "bin"
    }

    /**
     * A title for the note.
     *
     * The subject line when the sending app supplies one, otherwise the single file's own
     * name, otherwise the date — because an untitled note is much harder to find later than
     * one named for the afternoon it arrived.
     */
    fun deriveTitle(subject: String?, staged: List<StagedFile>, now: Date = Date()): String {
        val cleaned = subject?.trim().orEmpty()
        if (cleaned.isNotEmpty()) return cleaned.take(200)
        if (staged.size == 1) {
            val stem = staged[0].filename.substringBeforeLast('.', staged[0].filename)
            if (stem.isNotEmpty()) return stem.take(200)
        }
        return "Capture ${SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(now)}"
    }

    fun jobDir(context: Context, jobId: String): File =
        File(File(context.cacheDir, "shares"), jobId)

    /** Best-effort cleanup once a job is done or permanently failed. */
    fun clear(context: Context, jobId: String) {
        jobDir(context, jobId).deleteRecursively()
    }
}
