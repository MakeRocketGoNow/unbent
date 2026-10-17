package com.makerocketgonow.unbent.api

import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
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

/**
 * An API call that failed with a status, so 401 can be handled differently from the rest.
 *
 * [retryAfter] is the response's `Retry-After`, when it sent one: the server's own word
 * that the failure is passing and worth waiting out. Only the session check's 503 sends
 * it (the one a spent database allowance produces) so it is what tells that apart from
 * a 503 that will fail the same way however long a capture waits.
 */
class ApiException(
    val status: Int,
    message: String,
    val body: String = "",
    val retryAfter: String? = null,
) : IOException(message) {
    /**
     * The server's own explanation, pulled out of the JSON body this wraps.
     *
     * Worth surfacing because some refusals are deliberate and actionable (a sign-up
     * allowlist rejecting an address, a notebook name already taken) and a generic "did
     * not work" sends the user to retry something that will refuse them again for the
     * same reason. Better Auth says `message`; this API's own routes say `error`.
     */
    fun serverMessage(): String? = runCatching {
        val obj = ApiJson.parseToJsonElement(body).jsonObject
        (obj["message"] ?: obj["error"])?.jsonPrimitive?.contentOrNull?.ifEmpty { null }
    }.getOrNull()

    /**
     * A request for a code refused because it carried no Turnstile token, which means the
     * instance turned the check on after this app read its config (`AppConfig.turnstile`).
     * The code the server's plugin answers with, beside its message.
     */
    val isMissingCaptcha: Boolean
        get() = status == 400 && runCatching {
            ApiJson.parseToJsonElement(body).jsonObject["code"]?.jsonPrimitive?.contentOrNull == "MISSING_RESPONSE"
        }.getOrDefault(false)
}

/**
 * The API, as the native screens and the capture worker use it.
 *
 * Blocking calls on OkHttp, deliberately: every caller is already on a worker or an IO
 * dispatcher, and a suspend wrapper per method would be ceremony over `execute()`. The
 * streaming upload is what lets a 90MB video go up inside a phone's memory budget:
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
     * one. See the note under Auth in docs/self-hosting.md; the CLI hits the same requirement.
     */
    private fun Request.Builder.auth() = apply {
        if (bearer != null) header("Authorization", "Bearer $bearer")
        header("Origin", origin)
    }

    /**
     * `origin + path`, with any non-null query parameters.
     *
     * A value may be a list, which is written as the same key repeated: `?tag=a&tag=b`,
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
            if (!res.isSuccessful) {
                throw ApiException(res.code, "$what failed: ${res.code}", text, res.header("Retry-After"))
            }
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

    fun listNotebooks(): NotebookList = get("List notebooks", url("/api/notebooks"))

    fun listTags(): List<Tag> = get<TagList>("List tags", url("/api/tags")).tags

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
