package com.makerocketgonow.unbent.share

import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.ApiJson
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Why the server would not take a capture that there is nothing wrong with: the account
 * has no room for it. A 402, with a `code` in its body that says which room.
 *
 * Apart from every other 4xx because the answer changes when the person acts. A name the
 * server will not take is refused the same way however often it is sent, so the capture
 * is given up on; a plan that has ended is not, the moment someone subscribes or deletes
 * their way under the free plan. So a refused capture is kept (see [CaptureResume]) and
 * its notification says which of these it was and opens the Plan page, which has the
 * numbers. It used to say "Could not save to Unbent" and delete what was shared, which
 * read as the app being broken to the one person who could have fixed it in a minute.
 *
 * The web app keeps a refused write for the same reason (`plan-refused.ts` and
 * `store-full.ts` there), and the iOS app's half is `CaptureRefusal` in `CaptureJob.swift`.
 */
enum class CaptureRefusal {
    /** `PLAN_INACTIVE`: no plan holding, and more kept than the free plan allows. Read-only. */
    PLAN_ENDED,

    /** `FREE_NOTES_FULL`: a free account at its count of notes. Only a new note is refused. */
    FREE_NOTES_FULL,

    /** `STORAGE_FULL` of files: the plan's storage has no room for this file. */
    STORAGE_FULL,

    /** `STORAGE_FULL` of notes: the notes themselves take more room than the plan allows. */
    NOTES_FULL,

    /**
     * A 402 that names none of those: a code from a server newer than this build. Still
     * the plan's refusal, and still answered on the Plan page, so it is kept like the
     * rest and says the least it can be sure of.
     */
    PLAN;

    companion object {
        /** The refusal [e] is, or null for any failure that is not the plan's. */
        fun of(e: ApiException): CaptureRefusal? {
            if (e.status != 402) return null
            return when (e.code()) {
                "PLAN_INACTIVE" -> PLAN_ENDED
                "FREE_NOTES_FULL" -> FREE_NOTES_FULL
                "STORAGE_FULL" -> if (field(e.body, "of") == "notes") NOTES_FULL else STORAGE_FULL
                else -> PLAN
            }
        }

        private fun field(body: String, name: String): String? = runCatching {
            ApiJson.parseToJsonElement(body).jsonObject[name]?.jsonPrimitive?.contentOrNull
        }.getOrNull()
    }
}
