package com.makerocketgonow.unbent.ui

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import java.io.BufferedOutputStream
import java.io.File
import java.io.OutputStream
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Files the page writes into the phone's Downloads, a piece at a time.
 *
 * The site builds an export's zip itself (apps/web/src/export-archive.ts). In a browser it
 * writes to a file the person picked or hands over a `blob:` download at the end; a
 * WebView has no picker, and a `blob:` address is readable only by the page that made it,
 * so the download manager handed one fetches nothing. So the page streams the bytes here
 * through the bridge, and they go to storage as they come — a library far larger than the
 * WebView could hold in memory exports the same as a notebook.
 *
 * Every call is synchronous and comes in on WebView's bridge thread, not the main one,
 * which is what makes streaming safe: a page writing faster than the storage waits on
 * each call instead of queueing the library in memory. Several saves may be open at once,
 * keyed by an id this hands out, though the site only ever runs one.
 *
 * A save that ends without [end] — the export stopped or failed, or the page went away —
 * is removed, never left half-written in Downloads where it would look like a backup.
 */
class SaveStreams(private val create: (name: String, type: String) -> Target?) {

    /** Where one save's bytes go, and how it is kept or thrown away at the end. */
    class Target(
        val stream: OutputStream,
        val keep: () -> Unit,
        val discard: () -> Unit,
    )

    private val open = ConcurrentHashMap<String, Target>()

    /** Starts a save. The id to write to, or empty when nothing could be created. */
    fun begin(name: String, type: String): String {
        val target = runCatching { create(safeName(name), type) }.getOrNull() ?: return ""
        val id = UUID.randomUUID().toString()
        open[id] = target
        return id
    }

    /** Appends one piece, base64 as the bridge carries it. False when it could not be written. */
    fun chunk(id: String, base64: String): Boolean {
        val target = open[id] ?: return false
        return runCatching { target.stream.write(Base64.getDecoder().decode(base64)) }
            .onFailure { abort(id) }
            .isSuccess
    }

    /** Finishes a save and keeps the file. False when it could not be. */
    fun end(id: String): Boolean {
        val target = open.remove(id) ?: return false
        return runCatching {
            target.stream.close()
            target.keep()
        }.onFailure { runCatching { target.discard() } }.isSuccess
    }

    /** Throws a save away. Harmless for an id that has already ended or never began. */
    fun abort(id: String) {
        val target = open.remove(id) ?: return
        runCatching { target.stream.close() }
        runCatching { target.discard() }
    }

    /** Throws away every save still open: the WebView that was writing them is gone. */
    fun abortAll() {
        open.keys.toList().forEach(::abort)
    }

    companion object {
        /**
         * The name as a file in Downloads can have it: no directories, no control
         * characters, no leading dot that would hide it, and something when nothing is left.
         */
        fun safeName(raw: String): String {
            val name = raw
                .substringAfterLast('/')
                .substringAfterLast('\\')
                .replace(Regex("[\\x00-\\x1f]"), "")
                .trim()
                .trimStart('.')
                .take(200)
            return name.ifEmpty { "unbent-export.zip" }
        }

        /** Saves into the phone's public Downloads, where the Files app shows them. */
        fun downloads(context: Context): SaveStreams = SaveStreams { name, type ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) mediaStore(context, name, type)
            else appDownloads(context, name)
        }

        /**
         * A row in MediaStore's Downloads, pending while it is written so nothing else
         * sees a half-written archive, and published by [Target.keep]. The platform
         * suffixes the name itself when it is taken. No permission is needed for this.
         */
        @RequiresApi(Build.VERSION_CODES.Q)
        private fun mediaStore(context: Context, name: String, type: String): Target? {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, type)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
            val stream = resolver.openOutputStream(uri) ?: run {
                resolver.delete(uri, null, null)
                return null
            }
            return Target(
                stream = BufferedOutputStream(stream, 256 * 1024),
                keep = {
                    resolver.update(
                        uri,
                        ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
                        null,
                        null,
                    )
                },
                discard = { resolver.delete(uri, null, null) },
            )
        }

        /**
         * Below Android 10, public Downloads needs a storage permission this app does not
         * ask for, so the file goes to the app's own Downloads folder — the same place
         * [download] puts attachments on those versions.
         */
        private fun appDownloads(context: Context, name: String): Target? {
            val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return null
            dir.mkdirs()
            val file = distinct(dir, name)
            return Target(
                stream = BufferedOutputStream(file.outputStream(), 256 * 1024),
                keep = {},
                discard = { file.delete() },
            )
        }

        private fun distinct(dir: File, name: String): File {
            var candidate = File(dir, name)
            var n = 2
            val stem = name.substringBeforeLast('.')
            val ext = name.substringAfterLast('.', "").let { if (it.isEmpty()) "" else ".$it" }
            while (candidate.exists()) {
                candidate = File(dir, "$stem ($n)$ext")
                n++
            }
            return candidate
        }
    }
}
