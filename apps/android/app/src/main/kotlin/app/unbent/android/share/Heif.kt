package app.unbent.android.share

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import androidx.annotation.ChecksSdkIntAtLeast
import androidx.annotation.RequiresApi
import java.io.File
import java.util.Locale

/**
 * HEIC, and what to do about it.
 *
 * HEIC is what a phone camera set to "high efficiency" hands over, and nothing but Safari
 * can show it: the server serves inline only an allowlist of image types, HEIC is not on
 * it, and Chrome could not render it anyway. So a photo is transcoded to JPEG on the
 * phone, which is the one place that can decode it, before it goes anywhere.
 *
 * One object because two paths need it — the share sheet's staging and the note screen's
 * file chooser — and because the two were about to disagree on details that matter: the
 * name the JPEG gets, and what happens on a phone too old to decode.
 */
object Heif {

    private val TYPES = setOf("image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence")

    fun isHeif(contentType: String?): Boolean {
        val type = contentType?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT) ?: return false
        return type in TYPES
    }

    /**
     * `ImageDecoder` arrived in API 28 and minSdk is 26. Below it the file is left as it
     * is — uploaded, not rendered — rather than crashing the share, which is what calling
     * the decoder unguarded used to do. Such a phone is unlikely to produce HEIC at all:
     * the format's support came in the same release.
     */
    @get:ChecksSdkIntAtLeast(api = Build.VERSION_CODES.P)
    val canTranscode: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P

    /**
     * The JPEG's name: the original's stem, and `.jpg`.
     *
     * The extension is load-bearing, not cosmetic. Staging used to keep `IMG_1.HEIC` on
     * JPEG bytes and get away with it, because the server records the declared type and
     * that said `image/jpeg`. The file chooser has no such declaration: the WebView takes
     * a file's type from its name, so `.HEIC` would arrive as `image/heic`, which the
     * server will not serve inline, and the photo would download instead of render.
     */
    fun jpegName(displayName: String?, index: Int): String {
        val safe = Staging.sanitize(displayName, index, "jpg")
        return safe.substringBeforeLast('.', safe) + ".jpg"
    }

    /** Decodes [uri] and writes it to [target] as a JPEG. Off the main thread. */
    @RequiresApi(Build.VERSION_CODES.P)
    fun toJpeg(resolver: ContentResolver, uri: Uri, target: File) {
        val source = ImageDecoder.createSource(resolver, uri)
        val bitmap = ImageDecoder.decodeBitmap(source) { decoder, _, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            decoder.isMutableRequired = false
        }
        try {
            target.outputStream().use { out -> bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out) }
        } finally {
            bitmap.recycle()
        }
    }
}
