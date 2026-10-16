package com.makerocketgonow.unbent.ui

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import com.makerocketgonow.unbent.R
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The page's file chooser, answered by one activity: the system's file apps, the camera
 * beside them, HEIC made readable on the way back.
 *
 * A WebView opens no picker of its own: it asks its WebChromeClient and waits on a
 * callback, so every `<input type="file">` on the site comes here. For the editor's
 * Attach button that is a chooser of the phone's file apps with the camera offered
 * alongside, the way Chrome answers the same input: a photo of a receipt is the most
 * common thing attached from a phone, and making it a trip through the camera app and back
 * through the gallery was three steps where one would do. An input that asks for capture
 * outright goes straight to the camera. An input that only takes other kinds of file
 * (Import's) never offers it.
 *
 * Constructed in the activity's `onCreate`, because a result launcher has to be registered
 * before the activity starts. The folder it writes photos to lives as long as the activity
 * does; [close] deletes it once the WebView that might read from it is gone.
 */
class AttachChooser(private val activity: ComponentActivity, private val scope: CoroutineScope) {
    private val context = activity.applicationContext
    private val request = FileChooserRequest()
    private val dir = AttachCache.dir(context)
    private var shot: CameraShot? = null
    private var granted: List<String> = emptyList()

    private val launcher = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        answer(it.resultCode, it.data)
    }

    /** The WebChromeClient's `onShowFileChooser`: true when something was opened to answer it. */
    fun open(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        request.open(callback)
        discardShot()
        val camera = if (acceptsImages(params.acceptTypes)) cameraCapture(context, dir) else null
        shot = camera
        camera?.let(::grant)

        // `createIntent` is GET_CONTENT with OPENABLE, the accepted types, and multiple
        // selection when the input allows it; nothing to add to it.
        val launch = when {
            camera != null && params.isCaptureEnabled -> camera.intent
            camera != null ->
                Intent.createChooser(params.createIntent(), activity.getString(R.string.attach_choose))
                    .putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera.intent))
            else -> params.createIntent()
        }
        // A phone with nothing to answer throws here, and false is how Chromium is told the
        // request was not taken: answering as well would be answering twice.
        return runCatching { launcher.launch(launch) }
            .onFailure {
                request.forget()
                discardShot()
            }
            .isSuccess
    }

    /**
     * Deletes the photos this activity took for the page. Call once its WebView is
     * destroyed, when nothing can still be reading them.
     */
    fun close() {
        discardShot()
        val folder = dir
        thread { folder.deleteRecursively() }
    }

    private fun answer(resultCode: Int, data: Intent?) {
        val taken = shot
        shot = null
        revoke(taken)
        val chosen = chosenFiles(context, resultCode, data, taken)
        if (taken != null && taken.uri !in chosen) taken.file.delete()
        if (chosen.isEmpty()) {
            request.answer(null)
            return
        }
        // Answered on the main thread, where the WebView expects it.
        scope.launch {
            val ready = withContext(Dispatchers.IO) {
                runCatching { AttachCache.prepare(context, chosen, dir) }.getOrDefault(chosen)
            }
            request.answer(ready.toTypedArray())
        }
    }

    /**
     * Grants the photo's address to every camera by name. The intent's own grant is enough
     * when the camera is launched directly, but not always when it is offered inside a
     * chooser, which launches it on the app's behalf.
     */
    private fun grant(camera: CameraShot) {
        val flags = Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION
        granted = context.packageManager
            .queryIntentActivities(camera.intent, PackageManager.MATCH_DEFAULT_ONLY)
            .map { it.activityInfo.packageName }
            .distinct()
        granted.forEach { context.grantUriPermission(it, camera.uri, flags) }
    }

    private fun revoke(camera: CameraShot?) {
        if (camera == null) return
        runCatching {
            context.revokeUriPermission(
                camera.uri,
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION,
            )
        }
        granted = emptyList()
    }

    private fun discardShot() {
        val stale = shot ?: return
        shot = null
        revoke(stale)
        stale.file.delete()
    }
}
