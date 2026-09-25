package com.makerocketgonow.unbent

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback
import java.io.File
import androidx.test.core.app.ApplicationProvider
import com.makerocketgonow.unbent.ui.CameraShot
import com.makerocketgonow.unbent.ui.FileChooserRequest
import com.makerocketgonow.unbent.ui.acceptsImages
import com.makerocketgonow.unbent.ui.chosenFiles
import com.makerocketgonow.unbent.ui.chosenUris
import com.makerocketgonow.unbent.ui.trustedUris
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/*
 * Robolectric for real Intent, ClipData and Uri: the unit-test JVM stubs them to return
 * null from everything, and what is under test is precisely how they are read.
 */
@RunWith(RobolectricTestRunner::class)
class FileChooserTest {

    private val one = Uri.parse("content://media/external/images/1")
    private val two = Uri.parse("content://com.android.providers.downloads.documents/document/2")
    private val three = Uri.parse("content://com.android.externalstorage.documents/document/3")

    @Test
    fun `a cancelled picker chose nothing`() {
        assertEquals(emptyList<Uri>(), chosenUris(Activity.RESULT_CANCELED, Intent().setData(one)))
        assertEquals(emptyList<Uri>(), chosenUris(Activity.RESULT_OK, null))
        assertEquals(emptyList<Uri>(), chosenUris(Activity.RESULT_OK, Intent()))
    }

    @Test
    fun `a single choice arrives as the intent's data`() {
        assertEquals(listOf(one), chosenUris(Activity.RESULT_OK, Intent().setData(one)))
    }

    @Test
    fun `several choices arrive as clip data, in order`() {
        val clip = ClipData.newRawUri("files", one).apply {
            addItem(ClipData.Item(two))
            addItem(ClipData.Item(three))
        }
        val intent = Intent().apply { clipData = clip }
        assertEquals(listOf(one, two, three), chosenUris(Activity.RESULT_OK, intent))
    }

    @Test
    fun `only content URIs from other apps are trusted`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val ours = Uri.parse("content://${context.packageName}.files/attach/secret.jpg")
        val file = Uri.parse("file:///data/data/${context.packageName}/shared_prefs/unbent.xml")
        assertEquals(listOf(one, two), trustedUris(context, listOf(one, ours, file, two)))
    }

    /** A callback that remembers what it was told, and how many times. */
    private class Recording : ValueCallback<Array<Uri>> {
        val values = mutableListOf<Array<Uri>?>()
        override fun onReceiveValue(value: Array<Uri>?) {
            values += value
        }
    }

    @Test
    fun `answers the request once, and then forgets it`() {
        val request = FileChooserRequest()
        val callback = Recording()
        request.open(callback)
        assertTrue(request.isOpen)

        request.answer(arrayOf(one))
        request.answer(arrayOf(two)) // nothing open: ignored, not delivered twice
        assertFalse(request.isOpen)
        assertEquals(1, callback.values.size)
        assertEquals(listOf(one), callback.values[0]!!.toList())
    }

    @Test
    fun `a request opened over another answers the first with nothing`() {
        val request = FileChooserRequest()
        val first = Recording()
        val second = Recording()
        request.open(first)
        request.open(second)

        assertEquals(1, first.values.size)
        assertNull(first.values[0])
        assertTrue(second.values.isEmpty())

        request.answer(null)
        assertEquals(listOf<Array<Uri>?>(null), second.values)
    }

    @Test
    fun `a forgotten request is never answered`() {
        val request = FileChooserRequest()
        val callback = Recording()
        request.open(callback)
        request.forget()
        request.answer(arrayOf(one))
        assertTrue(callback.values.isEmpty())
        assertFalse(request.isOpen)
    }

    /**
     * The camera's photo, and only it. It lives on this app's own provider, which the picker's
     * results are never allowed to be, so it has to be recognised as the one this app minted.
     */
    private fun shot(written: Boolean): CameraShot {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val file = File(context.cacheDir, "attach/test/IMG_1.jpg").apply {
            parentFile?.mkdirs()
            if (written) writeBytes(byteArrayOf(1, 2, 3)) else delete()
        }
        val uri = Uri.parse("content://${context.packageName}.files/attach/test/IMG_1.jpg")
        return CameraShot(uri, file, Intent())
    }

    @Test
    fun `a photo the camera took is handed over`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val shot = shot(written = true)
        assertEquals(listOf(shot.uri), chosenFiles(context, Activity.RESULT_OK, null, shot))
        assertEquals(listOf(shot.uri), chosenFiles(context, Activity.RESULT_OK, Intent(), shot))
        assertEquals(listOf(shot.uri), chosenFiles(context, Activity.RESULT_OK, Intent().setData(shot.uri), shot))
    }

    @Test
    fun `a camera that wrote nothing took no photo`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertEquals(emptyList<Uri>(), chosenFiles(context, Activity.RESULT_OK, null, shot(written = false)))
        assertEquals(emptyList<Uri>(), chosenFiles(context, Activity.RESULT_CANCELED, null, shot(written = true)))
    }

    @Test
    fun `another address on this app's provider is still refused`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val other = Uri.parse("content://${context.packageName}.files/attach/other/secret.jpg")
        val result = chosenFiles(context, Activity.RESULT_OK, Intent().setData(other), shot(written = true))
        assertEquals(emptyList<Uri>(), result)
    }

    @Test
    fun `what the picker chose wins over the camera`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertEquals(listOf(one), chosenFiles(context, Activity.RESULT_OK, Intent().setData(one), shot(written = true)))
    }

    @Test
    fun `the camera is offered only where a photo would be taken`() {
        assertTrue(acceptsImages(arrayOf("")))
        assertTrue(acceptsImages(emptyArray()))
        assertTrue(acceptsImages(arrayOf("image/*")))
        assertTrue(acceptsImages(arrayOf("application/pdf", ".jpg")))
        assertFalse(acceptsImages(arrayOf(".enex", ".zip", ".md", "application/zip")))
    }
}
