package app.unbent.android.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The API's response shapes, mirroring `packages/shared/src/schemas.ts`.
 *
 * Kept as plain data with defaults for every optional field, and decoded leniently: a field
 * the server starts sending tomorrow must not crash an app installed today. The web app
 * gets that for free from TypeScript's structural typing; here it has to be a setting.
 */
internal val ApiJson = Json {
    ignoreUnknownKeys = true
    // Absent and null are the same thing to these models, and a null the server did not
    // send should not be sent back to it either.
    explicitNulls = false
    encodeDefaults = false
}

/**
 * The `notebook` filter value meaning "notes in no notebook", which the UI calls the Inbox.
 * A sentinel rather than an empty string so an absent filter and this one stay distinct;
 * the same string as `UNFILED` in schemas.ts.
 */
const val UNFILED = "[unfiled]"

/** `GET /api/config`: the sign-in methods an instance offers, in display order. */
@Serializable
data class AppConfig(val providers: List<String> = emptyList()) {
    val google: Boolean get() = "google" in providers
    val github: Boolean get() = "github" in providers
    val password: Boolean get() = "password" in providers
}

/** `GET /api/me`. The user is null rather than the call failing when there is no session. */
@Serializable
data class Me(val user: MeUser? = null)

@Serializable
data class MeUser(
    val id: String,
    val email: String,
    val name: String = "",
    val image: String? = null,
)

@Serializable
data class NoteSummary(
    val id: String,
    val title: String,
    val updatedAt: Long,
    val createdAt: Long,
    val tags: List<String> = emptyList(),
    val notebook: String? = null,
    val excerpt: String? = null,
    /** Set only on notes listed from the trash. */
    val deletedAt: Long? = null,
)

@Serializable
data class Note(
    val id: String,
    val title: String,
    val body: String,
    val updatedAt: Long,
    val createdAt: Long,
    val tags: List<String> = emptyList(),
    val notebook: String? = null,
)

/** One page of `GET /api/notes`. The total comes only with the first page. */
@Serializable
data class NotePage(
    val items: List<NoteSummary> = emptyList(),
    /** Pass back as `cursor` for the next page; null when there is no more. */
    val cursor: String? = null,
    val total: Int? = null,
)

/**
 * What `PUT /api/notes/:id/files` says about a file it stored.
 *
 * `indexing` is who extracts the file's text for search: `server`, in the background, or
 * `client`, meaning nobody has yet. A server older than the field leaves it null, which
 * means the same as `client`.
 */
@Serializable
data class UploadedFile(val filename: String, val indexing: String? = null) {
    val indexedByServer: Boolean get() = indexing == "server"
}

@Serializable
data class Notebook(val id: String, val name: String, val count: Int = 0)

/** `GET /api/notebooks`, with how many notes sit in no notebook at all. */
@Serializable
data class NotebookList(val notebooks: List<Notebook> = emptyList(), val unfiled: Int = 0)

@Serializable
data class Tag(val name: String, val count: Int = 0)

@Serializable
internal data class TagList(val tags: List<Tag> = emptyList())

@Serializable
data class SearchResult(
    val id: String,
    val title: String,
    val updatedAt: Long,
    val snippet: String = "",
    /** Set when the match came from an attachment's extracted text rather than the note. */
    val matchedFile: String? = null,
)

@Serializable
internal data class SearchResults(val results: List<SearchResult> = emptyList())

@Serializable
data class AttachmentInfo(val filename: String, val contentType: String, val size: Long)

/**
 * Where a note is filed, for [UnbentApi.updateNote].
 *
 * A type of its own because two absences mean different things: leaving the argument out
 * says "do not touch the notebook", while a [Filing] holding null says "the Inbox". The
 * server takes an explicit null for unfiled, and a plain nullable String cannot say both.
 */
data class Filing(val notebook: String?) {
    companion object {
        val INBOX = Filing(null)
    }
}
