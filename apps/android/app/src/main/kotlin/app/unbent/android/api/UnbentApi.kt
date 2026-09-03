package app.unbent.android.api

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

    /** `origin + path`, with any non-null query parameters. */
    private fun url(path: String, vararg query: Pair<String, String?>): HttpUrl =
        "$origin$path".toHttpUrl().newBuilder().apply {
            for ((name, value) in query) if (value != null) addQueryParameter(name, value)
        }.build()

    /** Runs a request and returns its body, or throws [ApiException] carrying the status. */
    private fun call(request: Request, what: String): String =
        client.newCall(request).execute().use { res ->
            val text = res.body?.string().orEmpty()
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
        tag: String? = null,
        sort: String? = null,
        order: String? = null,
        from: String? = null,
        to: String? = null,
        limit: Int = 50,
    ): NotePage = get(
        "List notes",
        url(
            "/api/notes",
            "cursor" to cursor,
            "notebook" to notebook,
            "tag" to tag,
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
        tag: String? = null,
        from: String? = null,
        to: String? = null,
    ): List<SearchResult> =
        get<SearchResults>(
            "Search",
            url("/api/search", "q" to q, "notebook" to notebook, "tag" to tag, "from" to from, "to" to to),
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

    /** Soft delete: the note goes to the trash, restorable from the web app. */
    fun deleteNote(id: String) {
        call(Request.Builder().url(noteUrl(id)).auth().delete().build(), "Delete note")
    }

    fun listNotebooks(): NotebookList = get("List notebooks", url("/api/notebooks"))

    /** Creates an empty notebook. A 409 means the name is taken, case-insensitively. */
    fun createNotebook(name: String): Notebook =
        send("Create notebook", url("/api/notebooks"), "POST", buildJsonObject { put("name", name) })

    fun listTags(): List<Tag> = get<TagList>("List tags", url("/api/tags")).tags

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

    /**
     * Streams one file to a note and asks the server to link it into the body.
     *
     * `link=1` exists because this client cannot write the markdown itself: it has no copy
     * of the note body and no cursor. The server appends the link atomically, which also
     * makes concurrent uploads to one note safe.
     */
    fun uploadFile(noteId: String, file: File, filename: String, contentType: String) {
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

        call(req, "Upload")
    }

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
