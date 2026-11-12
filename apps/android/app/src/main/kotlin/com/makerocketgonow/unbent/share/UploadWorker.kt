package com.makerocketgonow.unbent.share

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.makerocketgonow.unbent.Prefs
import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.UnbentApi
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * Creates the note and uploads the staged files.
 *
 * A worker rather than work on the share activity's thread: the share sheet should close
 * the instant the files are staged, and an upload over a phone radio outlives the activity
 * that started it. WorkManager also gives retries and a network constraint for free.
 *
 * Retries re-enter this function from the top. The note id is therefore written to the
 * staging directory as soon as the note exists, and files already on it are skipped:
 * otherwise a dropped radio after `createNote` would leave a second, empty note beside
 * the first. See [CaptureResume].
 *
 * A share that is one web address and nothing else is the page, not the address: the
 * server fetches it and keeps the article as the note, pictures and all (`POST /api/clip`,
 * [UnbentApi.clipLink]). That is what sharing a page from a browser means to the person
 * doing it, and a note holding a bare link was the only thing this could make before the
 * route existed. When the server cannot read the page (not HTML, too large, a site that
 * refused it, an address it will not fetch), or has no clipper (an instance whose operator
 * has not switched it on, or one from before the route), the capture falls back to that
 * note, so a share never fails for a page's sake: the link is kept either way, and the
 * notification says which of the two landed.
 *
 * A capture the account's plan has no room for (a 402) is neither retried nor given up
 * on: it is kept on the phone, its notification says why, and it is sent again when
 * there may be room. See [CaptureRefusal] and the 402 case below.
 */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val jobId = inputData.getString(KEY_JOB_ID) ?: return@withContext Result.failure()
        val title = inputData.getString(KEY_TITLE).orEmpty()
        val titleTyped = inputData.getBoolean(KEY_TITLE_TYPED, false)
        val body = inputData.getString(KEY_BODY).orEmpty()
        val names = inputData.getStringArray(KEY_FILENAMES).orEmpty()
        val types = inputData.getStringArray(KEY_TYPES).orEmpty()
        val notebook = inputData.getString(KEY_NOTEBOOK)
        val tags = inputData.getStringArray(KEY_TAGS).orEmpty().toList()
        val context = applicationContext

        val dir = Staging.jobDir(context, jobId)
        // A capture the plan refused, being sent again (see the 402 below). It says
        // nothing until it has an answer: "Saving…" would replace the notice that says
        // why it is waiting, every time the app is opened, to be replaced by that notice
        // again a second later.
        val refusedBefore = CaptureResume.wasRefused(dir)
        /*
         * A resend whose capture is no longer kept has nothing to do: the job before it
         * finished, saved or given up on, and cleared the directory between this one's
         * input being read from it and its being enqueued, when the unique name no
         * longer held it back. Carrying on would find no note id and no chosen id, and
         * make a second note without its files, then say "Saved".
         */
        if (inputData.getBoolean(KEY_RESUMED, false) && !refusedBefore) return@withContext Result.success()
        if (!refusedBefore) CaptureNotifications.saving(context, jobId, title)

        val prefs = Prefs(context)
        if (!prefs.isSignedIn && refusedBefore) {
            // Signed out since this resend was enqueued. Nobody is at a sign-in screen
            // on its account, so there is nothing to wait five minutes for, and the
            // wait below ends by clearing the capture. It is kept, marker and all, and
            // `CaptureWork.resumeRefused` sends it once someone is signed in.
            return@withContext Result.failure()
        }
        if (!prefs.isSignedIn) {
            /*
             * No session yet. ShareActivity has already opened the sign-in screen: it can,
             * being foreground at the time; a worker can run at any moment and must not
             * throw a screen over whatever the user is doing.
             *
             * So this simply waits for the token that sign-in is about to write, and the
             * capture completes on its own. The staged files sit on disk meanwhile, so
             * nothing is lost if it takes the user a while.
             */
            if (!awaitSession(prefs)) {
                // Gave up, or never finished signing in. Say so rather than dropping it
                // silently: the user shared something and deserves to know it did not land.
                CaptureNotifications.signInNeeded(context, jobId, title)
                Staging.clear(context, jobId)
                return@withContext Result.failure()
            }
        }

        val api = UnbentApi(prefs.instance, prefs.session?.bearer ?: return@withContext Result.failure())

        fun giveUp(): Result {
            Staging.clear(context, jobId)
            CaptureNotifications.failed(context, jobId, title)
            return Result.failure()
        }

        // Attempts that failed for a reason of their own; see the 503 case below.
        fun attemptsSpent() = runAttemptCount - CaptureResume.unavailableAttempts(dir)

        try {
            /*
             * A kept capture goes only as the account it was shared from (see
             * `KeptCapture`). Asked before anything is written, and of the server, since
             * the app holds a session and not a name: someone else has signed in on this
             * instance since, and the capture is left where it is, for its owner's return
             * or the sweep. No session at all is the 401 below.
             */
            val owner = if (refusedBefore) CaptureResume.kept(dir)?.account else null
            if (owner != null) {
                val me = api.me()?.id ?: throw ApiException(401, "Session check")
                // Remembered, so the next choosing passes this capture over without
                // asking, and it does not stand in front of the signed-in account's own.
                prefs.account = me
                if (me != owner) return@withContext Result.failure()
            }

            /*
             * Create once, remember the id, reuse it on retry.
             *
             * WorkManager re-runs this whole function after a network failure. Creating
             * the note again would leave a duplicate beside the one the first attempt
             * already made, often without its files, if the failure was the upload.
             * Written to the staging dir as soon as the server answers, so a process
             * death between create and the first PUT still finds the same note.
             */
            val pageUrl = if (names.isEmpty() && clipsOnAttempt(attemptsSpent())) lonePageUrl(body) else null
            // Whether the note is the clipped page. Known only on the attempt that made
            // it, which is the one that posts "Saved"; a retry that finds the note made
            // says "Saved" like any other, since it cannot tell.
            var clipped = false
            var noteTitle = title
            val noteId = CaptureResume.readNoteId(dir) ?: run {
                /*
                 * The same id on every attempt, for both requests. A clip is a fetch of
                 * the page and a note made from it, and an answer lost on the radio would
                 * otherwise clip the page twice; the server answers an id it already
                 * holds with that note. The fallback's create carries it too, so a clip
                 * that landed unheard and a retry that then fell back still meet at one
                 * note.
                 */
                val chosen = CaptureResume.chosenNoteId(dir)
                val note = if (pageUrl == null) {
                    api.createNote(title, body, tags, notebook, id = chosen)
                } else {
                    try {
                        api.clipLink(pageUrl, title.takeIf { titleTyped }, tags, notebook, id = chosen).also { clipped = true }
                    } catch (e: ApiException) {
                        if (!clipFallsBack(e)) throw e
                        // The page could not be read; the link is still worth a note,
                        // which is what this capture made before the route existed.
                        api.createNote(title, body, tags, notebook, id = chosen)
                    }
                }
                noteTitle = note.title
                CaptureResume.writeNoteId(dir, note.id)
                note.id
            }

            val already = if (names.isEmpty()) {
                emptySet()
            } else {
                api.listAttachments(noteId).map { it.filename }.toSet()
            }

            // Whether any file still needs its text extracted here. The server does it
            // itself where it can, and says so; the indexing job then has nothing to do.
            var needsIndex = false
            names.forEachIndexed { i, name ->
                val type = types.getOrElse(i) { "application/octet-stream" }
                if (name in already) {
                    // Landed on an earlier attempt. Still index a PDF: this attempt will
                    // not hear whether the server extracted it, and skipping that would
                    // leave a capture unsearchable until something else opened the app.
                    if (IndexWorker.needsIndexing(listOf(type))) needsIndex = true
                    return@forEachIndexed
                }
                val file = File(dir, name)
                // A file missing from the cache cannot be recovered by retrying; skip it
                // rather than failing the whole capture and losing the others.
                if (file.exists()) {
                    val uploaded = api.uploadFile(noteId, file, name, type)
                    if (IndexWorker.needsIndexing(listOf(type)) && !uploaded.indexedByServer) needsIndex = true
                }
            }

            Staging.clear(context, jobId)
            // A kept capture landed, so there is room: the others kept for the same
            // reason were waiting on this answer (`CaptureWork.firstOfEach`).
            if (refusedBefore) CaptureWork.resumeRefused(context)

            // The page's own title where the server chose it: "Saved" names what landed.
            CaptureNotifications.saved(context, jobId, noteTitle, noteId, clipped)
            // This job's output is the indexing job's input: which note, and whether there
            // is anything left for it to do.
            Result.success(workDataOf(KEY_NOTE_ID to noteId, KEY_NEEDS_INDEX to needsIndex))
        } catch (e: ApiException) {
            val refusal = CaptureRefusal.of(e)
            if (e.status == 401) {
                // The session is gone, not merely unreachable. Retrying cannot fix it, and
                // the stale token would keep failing silently on every later share.
                prefs.clearSession()
                if (refusedBefore) {
                    /*
                     * A capture kept for the plan is kept for the sign-in too. A lapsed
                     * account that has not opened the app in weeks is exactly whose
                     * session has run out, and clearing here deleted what the notice
                     * had said was kept, then asked for it to be shared again from a
                     * source that may be gone. The marker stays, which is what has
                     * `CaptureWork.resumeRefused` send it after the sign-in. The iOS
                     * app keeps every capture through a 401 (`CaptureJob.handle`).
                     */
                    CaptureNotifications.signInNeeded(context, jobId, title, kept = true)
                } else {
                    Staging.clear(context, jobId)
                    CaptureNotifications.signInNeeded(context, jobId, title)
                }
                Result.failure()
            } else if (refusal != null) {
                /*
                 * The plan has no room for this: it has ended, or its storage is full.
                 * Nothing is wrong with the capture and trying again now changes
                 * nothing, but the answer changes the moment the person subscribes or
                 * deletes something, so the capture is kept rather than given up on, and
                 * the notice says which it was and opens the Plan page.
                 *
                 * Failed, not retried. WorkManager's backoff would ask again in thirty
                 * seconds and then ever more rarely, up to five hours apart: wrong both
                 * ways, since a person who has just subscribed waits hours and one who
                 * has not is asked about all day. The capture is sent again when the app
                 * is next opened or something else is shared (`CaptureWork.resumeRefused`),
                 * which are the moments after someone could have done something about it.
                 * A Retry button on the notice was the other way, and is one more thing
                 * to press for a result the app can find out for itself.
                 *
                 * Whatever landed stays landed: the note id and the files already on the
                 * note are found again by the next attempt, as on any retry.
                 */
                val before = CaptureResume.kept(dir)
                val now = System.currentTimeMillis()
                // Asked once, at the first refusal, and carried from then on. A failure
                // to ask is not a reason to lose the capture; see `KeptCapture.account`.
                val account = before?.account ?: runCatching { api.me()?.id }.getOrNull()?.also { prefs.account = it }
                val kept = KeptCapture(
                    refusal.name,
                    prefs.instance,
                    account,
                    at = now,
                    count = (before?.count ?: 0) + 1,
                    since = before?.since ?: now,
                )
                if (kept.expired(now)) {
                    // Thirty days of asking is enough; see `KeptCapture.expired`.
                    giveUp()
                } else {
                    CaptureResume.keepRefused(dir, inputData.toByteArray(), kept)
                    // Quietly the second time: it is the same news, about the same capture.
                    CaptureNotifications.refused(context, jobId, title, refusal, quiet = refusedBefore)
                    Result.failure()
                }
            } else if (waitsOut(e)) {
                /*
                 * The server is up but cannot serve right now, and has said so. The case
                 * that matters is the database's daily read allowance running out: every
                 * request fails the same way until it resets at midnight UTC, which can be
                 * most of a day away. Four attempts on a backoff from thirty seconds are
                 * spent in under four minutes, and the capture was deleted with them. So
                 * this does not spend one; it waits for up to [MAX_UNAVAILABLE] of them
                 * instead.
                 */
                if (CaptureResume.recordUnavailable(dir) <= MAX_UNAVAILABLE) {
                    CaptureNotifications.waiting(context, jobId, title)
                    Result.retry()
                } else {
                    giveUp()
                }
            } else if (attemptsSpent() < MAX_ATTEMPTS) {
                Result.retry()
            } else {
                giveUp()
            }
        } catch (e: Exception) {
            if (attemptsSpent() < MAX_ATTEMPTS) Result.retry() else giveUp()
        }
    }

    /**
     * Polls for a session while the user connects, up to [CONNECT_WAIT_MS].
     *
     * A poll rather than a callback because the session is written by another activity in
     * this same process, and a broadcast or an observer would be more machinery than a
     * one-second check for something a person is doing by hand. False on timeout.
     */
    private suspend fun awaitSession(prefs: Prefs): Boolean {
        val deadline = System.currentTimeMillis() + CONNECT_WAIT_MS
        while (System.currentTimeMillis() < deadline) {
            delay(1_000)
            if (prefs.isSignedIn) return true
        }
        return false
    }

    companion object {
        /**
         * Whether a failure is one to wait out rather than spend an attempt on: a 503 that
         * says when to come back. Not every 503: "reading images is not set up" fails the
         * same way on every try, and the edge's own error page for a Worker that ran out of
         * resources is not this server asking for time. Waiting a day on those re-uploads
         * the capture fourteen times to say what four attempts would have. The session
         * check's 503, the one a spent read allowance produces, sends `Retry-After`.
         */
        internal fun waitsOut(e: ApiException): Boolean = e.status == 503 && e.retryAfter != null

        /**
         * The address a share is, when it is one web address and nothing else: what the
         * server is asked to read as a page. Anything more (a sentence around the link, two
         * links, a link under a line of text) is text someone wrote and stays a note's
         * body as it was shared; anything that is not http(s) is not a page. A subject
         * beside the address (the page's title, which browsers send) does not count
         * against it: it travels as the title, not the text.
         *
         * The trailing punctuation a sentence leaves on a pasted link is not stripped,
         * since a lone address was not pasted into a sentence.
         */
        fun lonePageUrl(text: String): String? {
            val one = text.trim()
            if (one.isEmpty() || one.any { it.isWhitespace() }) return null
            if (!one.startsWith("http://", ignoreCase = true) && !one.startsWith("https://", ignoreCase = true)) return null
            return runCatching { java.net.URI(one) }.getOrNull()?.takeIf { !it.host.isNullOrEmpty() }?.let { one }
        }

        /**
         * Whether a clip the server refused is one to make the plain note for instead: the
         * answers `clipUrl` gives about the page. 413 is a page larger than it will read,
         * 415 a reply that is not HTML (a PDF, an image), 502 a site that refused or failed,
         * and 400 an address it does not fetch (a private network, a loopback; `BAD_URL`).
         * Each is the server saying it cannot have this page, and the link is still worth
         * keeping.
         *
         * 404 is the server saying it has no clipper at all: an instance whose operator has
         * not switched it on (`WEB_CLIP`, answered as `CLIP_OFF`) and an instance deployed
         * before the route existed, which answers a missing route the same way, with no
         * code. Both are the plain note this capture always made, so the app does not read
         * `/api/config` first to find out: that is a request on every share to save one on
         * the rare instance without the clipper, and the 404 says the same thing.
         *
         * A 400 can also be the request itself (a title too long), which the create then
         * repeats and is refused the same way: one request more, in a rare case, for a
         * rule the iOS app can share. Its answers arrive through a background session that
         * hands it the status and no body, so a code is nothing it could read, and two
         * phones that fall back on different answers to the same page would be a bug
         * report nobody could reproduce. Not a 402, which is the plan and refuses the
         * fallback the same way, and nothing the handler every capture has already
         * decides (401, 503 with `Retry-After`).
         */
        internal fun clipFallsBack(e: ApiException): Boolean = e.status in CLIP_FALLBACK_STATUSES

        /**
         * Whether this attempt asks for the page or settles for the plain note. The two
         * tries after [CLIP_ATTEMPTS] are the plain create, because the failures
         * [clipFallsBack] cannot see are often about the page too: a site that hangs past
         * every timeout, or an article that ends the Worker for its CPU, which the edge
         * answers with a bare 5xx. Those fail the same way on every try, and giving up after
         * four would delete a link that a one-row create would have kept, which is what this
         * capture made before the route existed. The same chosen id on all of them, so a
         * clip that landed unheard and a create that follows meet at one note.
         *
         * A clip the plan refuses (402, which the store answers only after the page is
         * read) spends none of these: the capture is kept as a clip and asks for the
         * page again each time it is sent, which `CaptureWork.refusedWaitMs` spaces
         * out, so that someone who then subscribes gets the
         * page they shared and not its address.
         */
        internal fun clipsOnAttempt(attemptsSpent: Int): Boolean = attemptsSpent < CLIP_ATTEMPTS

        private val CLIP_FALLBACK_STATUSES = setOf(400, 404, 413, 415, 502)

        const val KEY_JOB_ID = "jobId"
        const val KEY_TITLE = "title"
        /** Whether [KEY_TITLE] is one the person typed, rather than the one staging derived. */
        const val KEY_TITLE_TYPED = "titleTyped"
        const val KEY_BODY = "body"
        const val KEY_FILENAMES = "filenames"
        const val KEY_TYPES = "types"
        /** Null means the Inbox. */
        const val KEY_NOTEBOOK = "notebook"
        const val KEY_TAGS = "tags"
        /** True for a job started from a kept capture (`CaptureWork.resumeRefused`), not at Save. */
        const val KEY_RESUMED = "resumed"
        /** Output: the note this capture became. */
        const val KEY_NOTE_ID = "noteId"
        /** Output: false when the server extracted every PDF's text itself. */
        const val KEY_NEEDS_INDEX = "needsIndex"
        private const val MAX_ATTEMPTS = 4

        /** How many of [MAX_ATTEMPTS] may be spent on the page; see [clipsOnAttempt]. */
        private const val CLIP_ATTEMPTS = 2

        /**
         * How many 503s a capture waits through before it gives up: about 28 hours.
         *
         * WorkManager's backoff doubles from thirty seconds and stops growing at five
         * hours, so ten retries take about eight and a half hours and each after that
         * five more. Fourteen reaches past a full day, which is the longest the read
         * allowance can stay spent, whenever in the day it ran out. The cost of the cap
         * is a capture that lands up to five hours after the reset rather than on it;
         * WorkManager has one backoff per job and no way to honour the Retry-After.
         */
        private const val MAX_UNAVAILABLE = 14

        /** How long a capture waits for the user to finish connecting. */
        private const val CONNECT_WAIT_MS = 5 * 60 * 1000L
    }
}
