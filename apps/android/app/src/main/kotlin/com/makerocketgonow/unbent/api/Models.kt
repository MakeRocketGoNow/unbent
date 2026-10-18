package com.makerocketgonow.unbent.api

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

/**
 * `GET /api/config`: the sign-in methods an instance offers, in display order, and
 * [turnstile] where the instance checks a Turnstile token with the request for a sign-in
 * code (MAK-243). With it set, [com.makerocketgonow.unbent.ui.TurnstileChallenge] loads the
 * instance's `/turnstile` page for a token before [EmailOtpAuth.sendCode] is called.
 */
@Serializable
data class AppConfig(
    val providers: List<String> = emptyList(),
    val turnstile: TurnstileConfig? = null,
) {
    val password: Boolean get() = "password" in providers
    val passkey: Boolean get() = "passkey" in providers
    val emailOtp: Boolean get() = "email-otp" in providers

    /** Google is the only provider with a native sheet, so it is the only one named. */
    val google: Boolean get() = "google" in providers

    /**
     * Any OAuth provider that is not Google.
     *
     * They are deliberately not listed one button each. A phone has no account picker for
     * an arbitrary provider, so every one of them ends at the same place: /connect in a
     * browser, which offers whatever the instance configured. N buttons that all open the
     * same page would be a menu pretending to be a choice.
     *
     * Left as a count rather than a list because nothing here needs their names: an
     * instance can enable a provider this app has never heard of and the browser handles
     * it, which is the point of the server reporting plain strings.
     */
    val browserSocials: Int
        get() = providers.count { it !in LOCAL_METHODS && it != "google" }
}

/** The methods the apps implement themselves; everything else reported is OAuth. */
private val LOCAL_METHODS = setOf("password", "passkey", "email-otp")

/** Turnstile's site key: public, and only what the page draws the widget from. */
@Serializable
data class TurnstileConfig(val siteKey: String)

/**
 * `GET /api/me`. The user is null rather than the call failing when there is no session; when
 * the server could not check the session at all, the call fails with 503, which is not a
 * sign-out.
 */
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
data class Note(
    val id: String,
    val title: String,
    val body: String,
    val updatedAt: Long,
    val createdAt: Long,
    val tags: List<String> = emptyList(),
    val notebook: String? = null,
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

/**
 * A tag as `GET /api/tags` lists it. `color` is an index into the site's palette, which
 * `TagColors` holds a copy of; null from a server older than the colours.
 */
@Serializable
data class Tag(val name: String, val count: Int = 0, val color: Int? = null)

@Serializable
internal data class TagList(val tags: List<Tag> = emptyList())

@Serializable
data class AttachmentInfo(val filename: String, val contentType: String, val size: Long)

/** `GET /api/notes/:id/files`. */
@Serializable
internal data class AttachmentList(val files: List<AttachmentInfo> = emptyList())
