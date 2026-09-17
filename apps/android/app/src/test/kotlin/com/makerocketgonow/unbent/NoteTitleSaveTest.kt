package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.UnbentApi
import com.makerocketgonow.unbent.ui.NoteState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/**
 * The title field does not save a title that has not changed.
 *
 * Its debounce fires on time elapsed rather than on a change, so typing a space and
 * deleting it used to PATCH the title it already held — re-dating the note. The server
 * drops an unchanged key now, but the request is still worth not making: on a phone it is
 * a radio wake and a "Saving" flicker for a save with nothing in it.
 *
 * Asserted by counting what reaches a MockWebServer, because "sent nothing" is the whole
 * claim and any assertion on state alone would pass while the request still went out.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NoteTitleSaveTest {

    private lateinit var server: MockWebServer
    private lateinit var api: UnbentApi

    private val note =
        """{"id":"note-1","title":"Coupons","body":"","updatedAt":1,"createdAt":1,"tags":[],"notebook":null}"""

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = UnbentApi(server.url("/").toString().trimEnd('/'), "test-token")
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    /**
     * A loaded screen, with the load's GET already taken.
     *
     * `requestCount` is cumulative — `takeRequest` dequeues but does not decrement it — so
     * every assertion below is against [sent], the count since the screen loaded.
     */
    private suspend fun loaded(scope: TestScope): NoteState {
        server.enqueue(MockResponse().setResponseCode(200).setBody(note))
        val state = NoteState(api, "note-1", scope, StandardTestDispatcher(scope.testScheduler))
        state.load()
        server.takeRequest() // the GET
        baseline = server.requestCount
        return state
    }

    private var baseline = 0

    /** Requests the screen has made since it finished loading. */
    private fun sent(): Int = server.requestCount - baseline

    @Test
    fun `a title typed and put back sends nothing`() = runTest(StandardTestDispatcher()) {
        val state = loaded(this)

        state.changeTitle("Coupons ")
        state.changeTitle("Coupons")
        advanceUntilIdle()

        assertEquals("no PATCH should have been sent", 0, sent())
        assertEquals("Coupons", state.title)
    }

    @Test
    fun `a real rename still saves`() = runTest(StandardTestDispatcher()) {
        val state = loaded(this)
        server.enqueue(MockResponse().setResponseCode(200).setBody(note))

        state.changeTitle("Coupons and deals")
        advanceUntilIdle()

        assertEquals(1, sent())
        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("""{"title":"Coupons and deals"}""", req.body.readUtf8())
    }

    @Test
    fun `a second edit back to the saved title sends nothing more`() = runTest(StandardTestDispatcher()) {
        val state = loaded(this)
        server.enqueue(MockResponse().setResponseCode(200).setBody(note))

        // One real rename lands...
        state.changeTitle("Renamed")
        advanceUntilIdle()
        assertEquals(1, sent())
        server.takeRequest()
        baseline = server.requestCount

        // ...and typing back to it is then a no-op against what the server now holds.
        state.changeTitle("Renamed ")
        state.changeTitle("Renamed")
        advanceUntilIdle()
        assertEquals("the restored title should not be re-sent", 0, sent())
    }

    @Test
    fun `flushing on the way out sends nothing when the title is unchanged`() =
        runTest(StandardTestDispatcher()) {
            val state = loaded(this)

            // Leaving the screen flushes a pending save; there must be nothing to flush.
            state.changeTitle("Coupons ")
            state.changeTitle("Coupons")
            state.flushTitle()
            advanceUntilIdle()

            assertEquals(0, sent())
        }
}
