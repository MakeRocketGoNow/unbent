package com.makerocketgonow.unbent.api

import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody

/** An API call that failed with a status, so 401 can be handled differently from the rest. */
class ApiException(val status: Int, message: String, val body: String = "") : IOException(message) {
    /**
     * The server's own explanation, pulled out of the JSON body this wraps.
     *
     * Worth surfacing because some refusals are deliberate and actionable — a sign-up
     * allowlist rejecting an address, a notebook name already taken — and a generic "did
     * not work" sends the user to retry something that will refuse them again for the
     * same reason. Better Auth says `message`; this API's own routes say `error`.
     */
    fun serverMessage(): String? = runCatching {
        val obj = ApiJson.parseToJsonElement(body).jsonObject
        (obj["message"] ?: obj["error"])?.jsonPrimitive?.contentOrNull?.ifEmpty { null }
    }.getOrNull()
}

/**
 * The API, as the native screens and the capture worker use it.
 *
 * Blocking calls on OkHttp, deliberately: every caller is already on a worker or an IO
 * dispatcher, and a suspend wrapper per method would be ceremony over `execute()`. The
 * streaming upload is what lets a 90MB video go up inside a phone's memory budget —
 * `asRequestBody` on a File never loads it whole.
 */
class UnbentApi(
    private val origin: String,
    /** Null before sign-in, when the only call that makes sense is [config]. */
    private val bearer: String?,
    private val client: OkHttpClient = shared,
) {
    /**
     * Better Auth rejects requests without a trusted `Origin` as CSRF, so every call sends
     * one. See the note in the project README; the CLI hits the same requirement.
     */
    private fun Request.Builder.auth() = apply {
        if (bearer != null) header("Authorization", "Bearer $bearer")
        header("Origin", origin)
    }

    /**
     * `origin + path`, with any non-null query parameters.
     *
     * A value may be a list, which is written as the same key repeated — `?tag=a&tag=b`,
     * which is how the server takes several tags. Repeating the key rather than joining
     * on a delimiter because a tag name may contain the delimiter; the server's own
     * schema documents the same reasoning.
     */
    private fun url(path: String, vararg query: Pair<String, Any?>): HttpUrl =
        "$origin$path".toHttpUrl().newBuilder().apply {
            for ((name, value) in query) when (value) {
                null -> Unit
                is Iterable<*> -> for (v in value) if (v != null) addQueryParameter(name, v.toString())
                else -> addQueryParameter(name, value.toString())
            }
        }.build()

    /** Runs a request and returns its body, or throws [ApiException] carrying the status. */
    private fun call(request: Request, what: String): String =
        client.newCall(request).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw ApiException(res.code, "$what failed: ${res.code}", text)
            text
        }

    private inline fun <reified T> get(what: String, url: HttpUrl): T =
        ApiJson.decodeFromString(call(Request.Builder().url(url).auth().get().build(), what))

    private inline fun <reified T> send(what: String, url: HttpUrl, method: String, body: JsonObject): T =
        ApiJson.decodeFromString(
            call(Request.Builder().url(url).auth().method(method, body.asBody()).build(), what),
        )

    private fun JsonObject.asBody(): RequestBody = toString().toRequestBody(JSON)

    fun config(): AppConfig = get("Config", url("/api/config"))

    /** Who the stored session belongs to, or null when the server no longer knows it. */
    fun me(): MeUser? = get<Me>("Session check", url("/api/me")).user

    /**
     * `from` and `to` are inclusive `YYYY-MM-DD` days, read by the server in UTC, on the
     * date the sort shows: updated, created, or updated again under a title sort.
     */
    fun listNotes(
        cursor: String? = null,
        notebook: String? = null,
        tags: List<String> = emptyList(),
        /** Custom-field filters as their wire strings; see [FieldFilter]. Repeated, ANDed. */
        fields: List<String> = emptyList(),
        sort: String? = null,
        order: String? = null,
        from: String? = null,
        to: String? = null,
        limit: Int = 50,
        /** Lists the trash instead of live notes. It has one order and ignores the rest. */
        trashed: Boolean = false,
    ): NotePage = get(
        "List notes",
        url(
            "/api/notes",
            "cursor" to cursor,
            "notebook" to notebook,
            "tag" to tags,
            "field" to fields,
            "trashed" to if (trashed) "1" else null,
            "sort" to sort,
            "order" to order,
            "from" to from,
            "to" to to,
            "limit" to limit.toString(),
        ),
    )

    /**
     * Full-text search, narrowed by the same filters as the list. Ranked, so unsorted —
     * which is why its date range always means the created date.
     */
    fun search(
        q: String,
        notebook: String? = null,
        tags: List<String> = emptyList(),
        fields: List<String> = emptyList(),
        from: String? = null,
        to: String? = null,
    ): List<SearchResult> =
        get<SearchResults>(
            "Search",
            url(
                "/api/search",
                "q" to q,
                "notebook" to notebook,
                "tag" to tags,
                "field" to fields,
                "from" to from,
                "to" to to,
            ),
        ).results

    fun getNote(id: String): Note = get("Load note", noteUrl(id))

    /** Creates a note. Notebook omitted means unfiled, which the UI calls the Inbox. */
    fun createNote(
        title: String,
        body: String = "",
        tags: List<String> = emptyList(),
        notebook: String? = null,
    ): Note {
        val payload = buildJsonObject {
            put("title", title)
            put("body", body)
            if (tags.isNotEmpty()) putJsonArray("tags") { tags.forEach { add(it) } }
            if (notebook != null) put("notebook", notebook)
        }
        return send("Create note", url("/api/notes"), "POST", payload)
    }

    /**
     * Changes only the fields given.
     *
     * PATCH is partial on the server, and that is load-bearing: the WebView showing the
     * body saves `body` alone while this side saves the title and filing alone, so neither
     * can overwrite what the other just wrote. See [Filing] for why the notebook is not a
     * plain nullable String.
     */
    fun updateNote(
        id: String,
        title: String? = null,
        body: String? = null,
        tags: List<String>? = null,
        filing: Filing? = null,
    ): Note {
        val payload = buildJsonObject {
            if (title != null) put("title", title)
            if (body != null) put("body", body)
            if (tags != null) putJsonArray("tags") { tags.forEach { add(it) } }
            if (filing != null) {
                if (filing.notebook != null) put("notebook", filing.notebook) else put("notebook", JsonNull)
            }
        }
        return send("Update note", noteUrl(id), "PATCH", payload)
    }

    /** Soft delete: the note goes to the trash, where it can be restored. */
    fun deleteNote(id: String) {
        call(Request.Builder().url(noteUrl(id)).auth().delete().build(), "Delete note")
    }

    /** Brings a trashed note back. 404 when it is not this user's, or was never trashed. */
    fun restoreNote(id: String): Note = send(
        "Restore note",
        noteUrl(id).newBuilder().addPathSegment("restore").build(),
        "POST",
        buildJsonObject {},
    )

    /**
     * Permanently deletes one trashed note and the files it owned. No undo.
     *
     * Separate from [deleteNote] on purpose: that one is reversible and this one is not,
     * and a single method with a flag would make the difference a parameter rather than a
     * decision.
     */
    fun purgeNote(id: String) {
        call(
            Request.Builder()
                .url(noteUrl(id).newBuilder().addPathSegment("permanent").build())
                .auth().delete().build(),
            "Delete note forever",
        )
    }

    /**
     * Permanently deletes every trashed note and its files.
     *
     * `confirm=DELETE` is the server's own requirement, not a formality invented here: it
     * refuses a bare POST so a stray retry cannot empty an account. Scoped to the trash —
     * this client has no reason to offer the "everything" scope, which exists for
     * repeating a trial import from a desk.
     */
    fun emptyTrash(): PurgeResult = send(
        "Empty trash",
        url("/api/admin/purge-notes", "scope" to "trashed", "confirm" to "DELETE"),
        "POST",
        buildJsonObject {},
    )

    fun listNotebooks(): NotebookList = get("List notebooks", url("/api/notebooks"))

    /** Creates an empty notebook. A 409 means the name is taken, case-insensitively. */
    fun createNotebook(name: String): Notebook =
        send("Create notebook", url("/api/notebooks"), "POST", buildJsonObject { put("name", name) })

    /**
     * Renames a notebook. A 409 means another notebook already has that name.
     *
     * By id, unlike the list filter, which is by name: an id survives the rename, and the
     * rename is the whole reason this route exists. The server's own notebook routes
     * carry the same note.
     */
    fun renameNotebook(id: String, name: String): Notebook =
        send("Rename notebook", notebookUrl(id), "PATCH", buildJsonObject { put("name", name) })

    /**
     * Deletes a notebook. Its notes survive, unfiled, unless [trashNotes] is set — and
     * then they go to the trash, not the void: deleting an organisational label must never
     * permanently destroy what it organised.
     *
     * 204, so there is nothing to decode and this cannot go through [send].
     */
    fun deleteNotebook(id: String, trashNotes: Boolean = false) {
        val url = notebookUrl(id).newBuilder()
            .apply { if (trashNotes) addQueryParameter("trashNotes", "1") }
            .build()
        call(Request.Builder().url(url).auth().delete().build(), "Delete notebook")
    }

    fun listTags(): List<Tag> = get<TagList>("List tags", url("/api/tags")).tags

    /** A notebook's custom field definitions, in display order. 404 when it is not this user's. */
    fun listNotebookFields(notebookId: String): List<FieldDef> =
        get<FieldList>(
            "List fields",
            notebookUrl(notebookId).newBuilder().addPathSegment("fields").build(),
        ).fields

    /**
     * Revokes the session on the server. Best effort: a phone that has lost its network
     * still has to be able to sign out locally, and the web app's session list is where a
     * session that could not be revoked from here gets revoked instead.
     */
    fun signOut() {
        runCatching {
            call(
                Request.Builder().url(url("/api/auth/sign-out")).auth()
                    .post(buildJsonObject {}.asBody()).build(),
                "Sign out",
            )
        }
    }

    /** Files already stored on a note, so a retried capture can skip ones that landed. */
    fun listAttachments(noteId: String): List<AttachmentInfo> =
        get<AttachmentList>(
            "List files",
            noteUrl(noteId).newBuilder().addPathSegment("files").build(),
        ).files

    /**
     * Streams one file to a note and asks the server to link it into the body.
     *
     * `link=1` exists because this client cannot write the markdown itself: it has no copy
     * of the note body and no cursor. The server appends the link atomically, which also
     * makes concurrent uploads to one note safe.
     */
    fun uploadFile(noteId: String, file: File, filename: String, contentType: String): UploadedFile {
        val url = "$origin/api/notes/$noteId/files".toHttpUrl().newBuilder()
            .addQueryParameter("link", "1")
            .build()

        val req = Request.Builder()
            .url(url)
            .auth()
            // Percent-encoded because a header may not carry non-ASCII, and filenames do.
            .header("X-Filename", URLEncoder.encode(filename, "UTF-8"))
            .put(file.asRequestBody(contentType.toMediaTypeOrNull()))
            .build()

        return ApiJson.decodeFromString(call(req, "Upload"))
    }

    private fun notebookUrl(id: String): HttpUrl =
        "$origin/api/notebooks".toHttpUrl().newBuilder().addPathSegment(id).build()

    private fun noteUrl(id: String): HttpUrl =
        "$origin/api/notes".toHttpUrl().newBuilder().addPathSegment(id).build()

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaTypeOrNull()

        /**
         * Generous write timeout: an upload is a single large PUT over a phone radio, and
         * the default 10s aborts a big PDF that is progressing perfectly well.
         */
        val shared: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(10, TimeUnit.MINUTES)
                .build()
        }
    }
}
