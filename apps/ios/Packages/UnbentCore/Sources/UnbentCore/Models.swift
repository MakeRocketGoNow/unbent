import Foundation

/*
 * The API's response shapes, mirroring `packages/shared/src/schemas.ts`.
 *
 * Plain data with a default for every optional field. `Decodable` ignores keys it was not
 * told about, so a field the server starts sending tomorrow does not crash an app installed
 * today; what it does not forgive is a missing one, which is why each `init(from:)` below
 * reads the optional ones with `decodeIfPresent`.
 */

/// The `notebook` filter value meaning "notes in no notebook", which the UI calls the
/// Inbox. A sentinel rather than an empty string so an absent filter and this one stay
/// distinct; the same string as `UNFILED` in schemas.ts.
public let unfiled = "[unfiled]"

/// `GET /api/config`: the sign-in methods an instance offers, in display order.
public struct AppConfig: Decodable, Equatable, Sendable {
    public var providers: [String]

    public init(providers: [String] = []) {
        self.providers = providers
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        providers = try c.decodeIfPresent([String].self, forKey: .providers) ?? []
    }

    private enum CodingKeys: String, CodingKey { case providers }

    public var password: Bool { providers.contains("password") }
    public var passkey: Bool { providers.contains("passkey") }
    public var emailOtp: Bool { providers.contains("email-otp") }

    /// The two providers a phone has a sheet of its own for, so the two that are named.
    public var google: Bool { providers.contains("google") }
    public var apple: Bool { providers.contains("apple") }

    /// Any OAuth provider with no native sheet.
    ///
    /// Deliberately a count and not one button each: every one of them ends at the same
    /// place (/connect in a browser, which offers whatever the instance configured) and
    /// N buttons that all open the same page would be a menu pretending to be a choice.
    /// Nothing here needs their names, so an instance can enable a provider this app has
    /// never heard of and the browser handles it.
    public var browserSocials: Int {
        providers.filter { !Self.localMethods.contains($0) && $0 != "google" && $0 != "apple" }.count
    }

    /// The methods the apps implement themselves; everything else reported is OAuth.
    private static let localMethods: Set<String> = ["password", "passkey", "email-otp"]
}

/// `GET /api/me`. The user is nil rather than the call failing when there is no session; when
/// the server could not check the session at all, the call fails with 503, which is not a
/// sign-out.
public struct Me: Decodable, Sendable {
    public var user: MeUser?
}

public struct MeUser: Decodable, Equatable, Sendable {
    public var id: String
    public var email: String
    public var name: String
    public var image: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        email = try c.decode(String.self, forKey: .email)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        image = try c.decodeIfPresent(String.self, forKey: .image)
    }

    private enum CodingKeys: String, CodingKey { case id, email, name, image }
}

public struct Notebook: Decodable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var count: Int

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
    }

    private enum CodingKeys: String, CodingKey { case id, name, count }
}

/// `GET /api/notebooks`, with how many notes sit in no notebook at all.
public struct NotebookList: Decodable, Equatable, Sendable {
    public var notebooks: [Notebook]
    public var unfiled: Int

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        notebooks = try c.decodeIfPresent([Notebook].self, forKey: .notebooks) ?? []
        unfiled = try c.decodeIfPresent(Int.self, forKey: .unfiled) ?? 0
    }

    private enum CodingKeys: String, CodingKey { case notebooks, unfiled }
}

public struct Tag: Decodable, Equatable, Sendable {
    public var name: String
    public var count: Int

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
    }

    private enum CodingKeys: String, CodingKey { case name, count }
}

struct TagList: Decodable {
    var tags: [Tag]?
}
