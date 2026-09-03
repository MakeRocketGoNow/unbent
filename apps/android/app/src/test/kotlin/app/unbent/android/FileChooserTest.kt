package app.unbent.android

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback
import androidx.test.core.app.ApplicationProvider
import app.unbent.android.ui.FileChooserRequest
import app.unbent.android.ui.chosenUris
import app.unbent.android.ui.trustedUris
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
}
