package app.unbent.android

import app.unbent.android.share.IndexWorker
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Which captures get the indexing job: any with a PDF in it, and no other. */
class IndexWorkerTest {

    @Test
    fun `a PDF among photos needs indexing`() {
        assertTrue(IndexWorker.needsIndexing(listOf("image/jpeg", "application/pdf", "image/png")))
    }

    @Test
    fun `photos alone do not`() {
        assertFalse(IndexWorker.needsIndexing(listOf("image/jpeg", "image/heic")))
        assertFalse(IndexWorker.needsIndexing(emptyList()))
    }
}
