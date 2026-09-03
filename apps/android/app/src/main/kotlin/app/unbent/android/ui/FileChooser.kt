package app.unbent.android.ui

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback
import androidx.core.content.FileProvider
import app.unbent.android.share.Heif
import app.unbent.android.share.Staging
import java.io.File
import java.util.UUID

/*
 * The page's file chooser, answered by the app.
 *
 * The editor's Attach button is an `<input type="file">` inside the WebView, and a WebView
 * opens no picker of its own: it asks its WebChromeClient, hands over a callback, and
 * waits. What the app does with that — the system picker, HEIC on the way back, and the
 * answer — lives here, out of the screen's way, and mostly as plain functions so the
 * parts that decide anything run under a JVM test.
 */

/**
 * The one request the page may have open.
 *
 * Chromium will not ask for another picker until the last callback has been answered, so
 * a request dropped on the floor — a launch that threw, a second request before the
 * first came back — locks the Attach button for the life of the WebView. Every way out
 * of here answers it: [answer] with what was chosen, or null for nothing; [open] answers
 * a superseded request with null before adopting the new one; and [forget] is for a
 * launch that failed, where returning false to Chromium is what cancels, and answering
 * as well would be answering twice.
 */
class FileChooserRequest {
    private var callback: ValueCallback<Array<Uri>>? = null

    val isOpen: Boolean get() = callback != null

    fun open(next: ValueCallback<Array<Uri>>) {
        callback?.onReceiveValue(null)
        callback = next
    }

    fun answer(uris: Array<Uri>?) {
        val pending = callback ?: return
        callback = null
        pending.onReceiveValue(uris)
    }

    fun forget() {
        callback = null
    }
}

/**
 * What the picker returned, in the order it was chosen: several in `clipData`, one in
 * `data`, none when cancelled.
 *
 * Not the platform's `FileChooserParams.parseResult`, which hands the work to the WebView
 * provider — and Chromium's reads `data` alone, so a multiple selection came back as its
 * first file.
 */
fun chosenUris(resultCode: Int, data: Intent?): List<Uri> {
    if (resultCode != Activity.RESULT_OK || data == null) return emptyList()
    val clip = data.clipData
    if (clip != null && clip.itemCount > 0) {
        return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    }
    return listOfNotNull(data.data)
}

/**
 * Only what a picker may legitimately hand over.
 *
 * The SDK's own note on `createIntent` says the result is untrusted: any app can answer
 * GET_CONTENT, and one could answer with a `file://` path into this app's private storage,
 * or a `content://` URI on this app's own provider — which the WebView would then read
 * with the app's permissions and upload as an attachment. A real picker returns
 * `content://` URIs on other apps' authorities, and that is all that passes.
 */
fun trustedUris(context: Context, uris: List<Uri>): List<Uri> = uris.filter { uri ->
    val authority = uri.authority
    uri.scheme == ContentResolver.SCHEME_CONTENT &&
        !authority.isNullOrEmpty() &&
        !authority.startsWith(context.packageName)
}

/**
 * Where a transcoded photo waits for the page to read it.
 *
 * A file the app made has to reach the WebView as a `content://` URI like the picker's
 * own, which is what the FileProvider declared in the manifest is for. The directory is
 * one screen's: the note screen deletes it when it leaves, by which time its WebView is
 * destroyed and nothing can still be reading.
 */
object AttachCache {

    fun authority(context: Context): String = "${context.packageName}.files"

    fun dir(context: Context): File =
        File(File(context.cacheDir, "attach"), UUID.randomUUID().toString())

    /**
     * HEIC becomes a JPEG in [dir], handed back through the provider; every other URI
     * passes through untouched, since the picker's grant is to this app and the WebView
     * reads it with the app's own resolver. Blocking: call it off the main thread.
     */
    fun prepare(context: Context, uris: List<Uri>, dir: File): List<Uri> {
        val resolver = context.contentResolver
        return uris.mapIndexed { index, uri ->
            if (!Heif.canTranscode || !Heif.isHeif(resolver.getType(uri))) return@mapIndexed uri
            runCatching {
                dir.mkdirs()
                val target = distinct(dir, Heif.jpegName(Staging.queryDisplayName(resolver, uri), index))
                Heif.toJpeg(resolver, uri, target)
                FileProvider.getUriForFile(context, authority(context), target)
            }.getOrDefault(uri) // A decode that fails: the HEIC goes as it is, and downloads rather than renders.
        }
    }

    /** Two photos both called IMG_0001.HEIC must not overwrite each other in the cache. */
    private fun distinct(dir: File, name: String): File {
        var candidate = File(dir, name)
        var n = 2
        while (candidate.exists()) {
            candidate = File(dir, name.substringBeforeLast('.') + "-$n." + name.substringAfterLast('.'))
            n++
        }
        return candidate
    }
}
