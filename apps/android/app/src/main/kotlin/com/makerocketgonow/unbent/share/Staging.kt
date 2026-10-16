package com.makerocketgonow.unbent.share

import android.content.ContentResolver
import android.content.Context
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
 * Copies shared content out of the sending app and into storage this app owns.
 *
 * This has to happen before the share activity finishes. The URI permission that comes with
 * a share is tied to the receiving activity's lifetime, so a worker that starts later finds
 * the grant revoked and reads nothing. Copying first costs a little disk and makes the
 * upload retryable, which matters on a phone radio.
 */
object Staging {

    fun stageAll(context: Context, uris: List<Uri>, jobId: String): List<StagedFile> {
        sweepAbandoned(File(context.noBackupFilesDir, SHARES), System.currentTimeMillis())
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

        // Transcode rather than upload, where the phone can: see Heif for why, and for
        // why the name has to change with the bytes.
        val transcode = Heif.isHeif(declaredType) && Heif.canTranscode

        val baseName = if (transcode) Heif.jpegName(displayName, index) else sanitize(displayName, index, extensionFor(declaredType))
        val filename = uniquify(baseName, used)
        val target = File(dir, filename)

        if (transcode) {
            Heif.toJpeg(resolver, uri, target)
            return StagedFile(target, filename, "image/jpeg")
        }

        resolver.openInputStream(uri)?.use { input ->
            target.outputStream().use { output -> input.copyTo(output) }
        } ?: throw IllegalStateException("Could not open $uri")

        return StagedFile(target, filename, declaredType.substringBefore(';').trim())
    }

    internal fun queryDisplayName(resolver: ContentResolver, uri: Uri): String? =
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
     * other apps are arbitrary: sometimes absent, sometimes a whole path.
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
     * name, otherwise the date, because an untitled note is much harder to find later than
     * one named for the afternoon it arrived.
     */
    fun deriveTitle(
        subject: String?,
        staged: List<StagedFile>,
        text: String? = null,
        sourceApp: String? = null,
        now: Date = Date(),
    ): String {
        // What the sending app called it. Mail and most browsers set this, and it is
        // almost always the best title available.
        subject?.trim()?.takeIf { it.isNotEmpty() }?.let { return it.take(200) }

        // A lone file: its own name, which the user chose or the camera dated.
        if (staged.size == 1) {
            val stem = staged[0].filename.substringBeforeLast('.', staged[0].filename)
            if (stem.isNotEmpty()) return stem.take(200)
        }

        val body = text?.trim().orEmpty()
        if (body.isNotEmpty()) {
            /*
             * A shared link, which arrives as bare text. The host is what someone would
             * recognise a month later: the full URL is unreadable in a list, and its
             * path is usually a slug or an id.
             */
            hostOf(body)?.let { host ->
                return if (sourceApp.isNullOrEmpty()) host else "$host, via $sourceApp".take(200)
            }
            // Plain text: its first line, which is how a note would title itself anyway.
            body.lineSequence().firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }
                ?.let { return it.take(200) }
        }

        /*
         * Nothing to go on. The app it came from beats a bare timestamp: "Photos" or
         * "Chrome" is at least a hint about what this was.
         */
        val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(now)
        return if (sourceApp.isNullOrEmpty()) "Capture $stamp" else "$sourceApp: $stamp".take(200)
    }

    /** The host of the first URL in some text, without the www. Null when there is none. */
    fun hostOf(text: String): String? {
        val match = Regex("""https?://\S+""").find(text) ?: return null
        return runCatching {
            java.net.URI(match.value).host?.removePrefix("www.")?.takeIf { it.isNotEmpty() }
        }.getOrNull()
    }

    /**
     * Where a capture's files wait for its upload.
     *
     * `noBackupFilesDir`, not `cacheDir`. A capture can now wait out a day of the server
     * being unavailable (see [UploadWorker]), and Android empties a cache under storage
     * pressure whenever it likes. Losing `.note-id` there made the retry create a second
     * note, and losing a staged file had the upload skip it and still say "Saved", a small
     * risk over the four minutes a capture used to last, a real one over a day. Nor is a
     * capture something a device backup should carry.
     *
     * A capture staged under the cache by an earlier build is still found there, so one
     * waiting through an app update carries on rather than losing its files; [clear]
     * removes both.
     */
    fun jobDir(context: Context, jobId: String): File =
        jobDir(context.noBackupFilesDir, context.cacheDir, jobId)

    internal fun jobDir(root: File, legacyRoot: File, jobId: String): File {
        val legacy = File(File(legacyRoot, SHARES), jobId)
        return if (legacy.exists()) legacy else File(File(root, SHARES), jobId)
    }

    /** Best-effort cleanup once a job is done or permanently failed. */
    fun clear(context: Context, jobId: String) {
        File(File(context.noBackupFilesDir, SHARES), jobId).deleteRecursively()
        File(File(context.cacheDir, SHARES), jobId).deleteRecursively()
    }

    /**
     * Deletes job directories nothing has touched in [ABANDONED_MS].
     *
     * [clear] is the cleanup, and every way a job ends through [UploadWorker] calls it.
     * This is for a job that never got there (cancelled, or forgotten by WorkManager)
     * whose files the cache would once have reclaimed on its own and this directory never
     * will. Touched means any file in it: a capture waiting on a 503
     * rewrites its count on every attempt, so a live one never looks abandoned.
     */
    internal fun sweepAbandoned(root: File, now: Long) {
        for (dir in root.listFiles().orEmpty()) {
            if (!dir.isDirectory) continue
            val touched = (dir.listFiles().orEmpty().map { it.lastModified() } + dir.lastModified()).max()
            if (now - touched > ABANDONED_MS) dir.deleteRecursively()
        }
    }

    private const val SHARES = "shares"

    /**
     * Three days: well past the longest a capture waits (about 28 hours of a server that
     * cannot serve, at five-hour gaps) so only a job WorkManager has let go of is swept.
     */
    private const val ABANDONED_MS = 3 * 24 * 60 * 60 * 1000L
}
