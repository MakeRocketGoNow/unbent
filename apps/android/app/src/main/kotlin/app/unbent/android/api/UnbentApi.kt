package app.unbent.android.api

import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** An API call that failed with a status, so 401 can be handled differently from the rest. */
class ApiException(val status: Int, message: String) : IOException(message)

/**
 * The two API calls a capture needs, plus a token check.
 *
 * Deliberately thin: create a note, then stream each file to it. This mirrors what the
 * browser does, and the streaming upload is what lets a 90MB video go up inside a phone's
 * memory budget — `asRequestBody` on a File never loads it whole.
 */
class UnbentApi(
    private val origin: String,
    private val token: String,
    private val client: OkHttpClient = shared,
) {
    /**
     * Better Auth rejects requests without a trusted `Origin` as CSRF, so every call sends
     * one. See the note in the project README; the CLI hits the same requirement.
     */
    private fun Request.Builder.auth() = apply {
        header("Authorization", "Bearer $token")
        header("Origin", origin)
    }

    /** Cheap liveness check for the stored token, so a dead one is reported once, not per file. */
    fun checkToken(): Boolean {
        val req = Request.Builder()
            .url("$origin/api/notes?limit=1")
            .auth()
            .get()
            .build()
        client.newCall(req).execute().use { res ->
            if (res.code == 401) return false
            if (!res.isSuccessful) throw ApiException(res.code, "Token check failed: ${res.code}")
            return true
        }
    }

    /** Creates an empty note. Returns its id. Notebook is omitted, so the note is unfiled. */
    fun createNote(title: String, body: String = ""): String {
        val payload = JSONObject()
            .put("title", title)
            .put("body", body)
            .toString()

        val req = Request.Builder()
            .url("$origin/api/notes")
            .auth()
            .post(payload.toRequestBody(JSON))
            .build()

        client.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) throw ApiException(res.code, "Create note failed: ${res.code} $text")
            return JSONObject(text).getString("id")
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

        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) {
                throw ApiException(res.code, "Upload failed: ${res.code} ${res.body?.string().orEmpty()}")
            }
        }
    }

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
