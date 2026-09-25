package com.makerocketgonow.unbent.ui

import android.app.Activity
import android.content.ClipData
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.webkit.ValueCallback
import androidx.core.content.FileProvider
import com.makerocketgonow.unbent.share.Heif
import com.makerocketgonow.unbent.share.Staging
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
 * A photo the camera is about to take: where it will be written, and the address the camera
 * was given to write it to.
 */
class CameraShot(val uri: Uri, val file: File, val intent: Intent)

/**
 * An intent that has the camera take one photo into [dir], or null when the phone has no
 * camera app to take it.
 *
 * The photo is written to a file this app owns and served to the camera through the
 * FileProvider, so the camera needs no storage permission and the photo never passes through
 * the gallery. The grant rides on the intent's clip data, which is what the platform reads
 * write permission from for `EXTRA_OUTPUT`; the caller grants it again to each camera by
 * name, because an intent offered inside a chooser does not always carry its grant through.
 */
fun cameraCapture(context: Context, dir: File): CameraShot? {
    val probe = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
    if (probe.resolveActivity(context.packageManager) == null) return null
    dir.mkdirs()
    val file = File(dir, "IMG_${System.currentTimeMillis()}.jpg")
    val uri = FileProvider.getUriForFile(context, AttachCache.authority(context), file)
    val intent = probe.apply {
        putExtra(MediaStore.EXTRA_OUTPUT, uri)
        clipData = ClipData.newRawUri("", uri)
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    return CameraShot(uri, file, intent)
}

/**
 * Whether a file input would take a photo: it names no types, or names an image among them.
 * Chromium hands over an empty string for an input with no `accept`, which is the editor's.
 */
fun acceptsImages(acceptTypes: Array<String>): Boolean {
    val types = acceptTypes.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
    if (types.isEmpty()) return true
    return types.any {
        it == "*/*" || it.startsWith("image/") || it in setOf(".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp")
    }
}

/**
 * What the page should be handed after the chooser closes.
 *
 * The picker's choices when there are any, read and filtered as always. Otherwise the photo
 * the camera took, if one was offered and a camera answered: a camera returns no URI at
 * all, or echoes the one it was given, and the photo is only real if something was written.
 *
 * The photo's URI is on this app's own provider, which [trustedUris] refuses on purpose — a
 * rogue picker could answer with one to read this app's files. So it is accepted here by
 * identity, as the one URI this app minted for this shot, and never by its authority.
 */
fun chosenFiles(context: Context, resultCode: Int, data: Intent?, shot: CameraShot?): List<Uri> {
    val picked = trustedUris(context, chosenUris(resultCode, data))
    if (picked.isNotEmpty()) return picked
    if (resultCode != Activity.RESULT_OK || shot == null) return emptyList()
    val echoed = data?.data
    val fromCamera = (echoed == null && data?.clipData == null) || echoed == shot.uri
    return if (fromCamera && shot.file.length() > 0) listOf(shot.uri) else emptyList()
}

/**
 * Where a transcoded photo, or one the camera just took, waits for the page to read it.
 *
 * A file the app made has to reach the WebView as a `content://` URI like the picker's
 * own, which is what the FileProvider declared in the manifest is for. The directory
 * belongs to one WebView's screen, which deletes it when it is destroyed, by which time
 * its WebView is gone and nothing can still be reading.
 */
object AttachCache {

    fun authority(context: Context): String = "${context.packageName}.files"

    fun dir(context: Context): File =
        File(root(context), UUID.randomUUID().toString())

    private fun root(context: Context): File = File(context.cacheDir, "attach")

    /**
     * Clears what an earlier run left behind. The activity deletes its own folder when it
     * is destroyed, but a process killed in the background never gets that far, and each
     * leftover is a photo or two sitting in the cache.
     */
    fun sweep(context: Context) {
        root(context).deleteRecursively()
    }

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
