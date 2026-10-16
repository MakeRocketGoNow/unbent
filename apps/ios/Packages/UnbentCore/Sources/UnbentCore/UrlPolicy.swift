import Foundation

/// Where an address opens, decided without WebKit so it runs under `swift test`.
///
/// The web view is this site and nothing else. A page that navigated it somewhere else
/// would be a page running with the app's session cookie and its bridge, so everything off
/// the site leaves: a web page for Safari's sheet over the app, where the person's own
/// browser session and address bar are, and anything that is not a web page for whichever
/// app handles it.
///
/// A port of `UrlPolicy.kt`, test for test. A case added to one belongs in the other.
public enum Destination: Equatable, Sendable {
    /// This site, or something the page made itself; stays in the web view.
    case inApp

    /// A web page elsewhere; a Safari sheet.
    case browser(String)

    /// `mailto:`, `tel:` and the rest; handed to the system.
    case other(String)
}

/// `url` against the site at `origin`.
///
/// The same site is the same scheme, host and port, compared as the platform compares
/// origins: `http://localhost:5232` and `http://localhost:8787` are two sites. `about:`,
/// `blob:` and `data:` are the page's own and stay; `javascript:` too, since it only ever
/// reaches here from the page itself. An address that does not parse is sent out rather
/// than trusted.
public func classify(origin: String, url: String) -> Destination {
    let scheme = url.firstIndex(of: ":").map { url[..<$0].lowercased() } ?? ""
    if ["about", "blob", "data", "javascript"].contains(scheme) { return .inApp }
    if scheme != "http" && scheme != "https" { return .other(url) }
    guard let target = URLComponents(string: url), let site = URLComponents(string: trimTrailingSlashes(origin)) else {
        return .browser(url)
    }
    return sameOrigin(site, target) ? .inApp : .browser(url)
}

/// The path a link to this site should open in the app, or nil when it names another site.
///
/// Matched on the host alone, because a link and the instance can differ in the rest and
/// still mean the same place: a link shared from the site is `https://`, a debug build
/// pointed at a laptop is `http://` on a port. The path and query are kept and later
/// rebased onto the instance the app is pointed at; a fragment means nothing to the router.
public func linkPath(instance: String, link: String) -> String? {
    guard let target = URLComponents(string: link), let site = URLComponents(string: trimTrailingSlashes(instance)) else {
        return nil
    }
    guard let scheme = target.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
    guard let host = target.host, let siteHost = site.host, host.caseInsensitiveCompare(siteHost) == .orderedSame else {
        return nil
    }
    let path = target.percentEncodedPath.isEmpty ? "/" : target.percentEncodedPath
    let query = target.percentEncodedQuery.map { "?\($0)" } ?? ""
    return path + query
}

/// The path a `target=_blank` to this site should open in place, or nil when it is not one.
///
/// The web view has no tabs. Loading the address into the app tears the page down
/// (unsaved edits, an upload in flight), which is why a link that names a note goes through
/// `__unbent.open` instead. A same-origin `_blank` is the same situation: a link in a note,
/// a URL field. Opening in place still leaves the current page, so it keeps what outlives a
/// route change and nothing more. Off-site addresses, and the `about:` / `blob:` /
/// `javascript:` URLs the page made itself, are not paths and stay nil.
public func inAppWindowPath(origin: String, url: String) -> String? {
    guard classify(origin: origin, url: url) == .inApp else { return nil }
    return linkPath(instance: origin, link: url)
}

/// A path on this site and nothing that could be read as another host.
public func isSitePath(_ path: String) -> Bool {
    path.hasPrefix("/") && !path.hasPrefix("//")
}

/// Where the page was before it fell to the site's sign-in at `current`, or `fallback`.
///
/// The site's gate sends a signed-out page to `/login?redirect=` with the place it was
/// bounced from (see `returnTo` in `auth-gate.ts`). When the app then finds the session was
/// fine after all (the page only lost the network), that is where it belongs, not the
/// list. The value is anything a URL can carry, so it is only followed when it is a path on
/// this site, and never when it is `/login` again, which the site's own `safeRedirect`
/// refuses for the same reason: a loop waiting for a cause.
public func returnPath(current: String?, fallback: String) -> String {
    guard let current, let url = URLComponents(string: current) else { return fallback }
    guard trimTrailingSlashes(url.percentEncodedPath) == "/login" else { return fallback }
    guard
        let raw = url.percentEncodedQuery?
            .split(separator: "&")
            .first(where: { $0.hasPrefix("redirect=") })?
            .dropFirst("redirect=".count),
        // A form-encoded value writes a space as `+`; the site's own encoder never does,
        // but the address is the page's to write and this reads both.
        let path = raw.replacingOccurrences(of: "+", with: " ").removingPercentEncoding
    else { return fallback }
    guard isSitePath(path) else { return fallback }
    let bare = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? path
    if trimTrailingSlashes(bare) == "/login" { return fallback }
    return path
}

private func sameOrigin(_ a: URLComponents, _ b: URLComponents) -> Bool {
    guard let schemeA = a.scheme, let schemeB = b.scheme, schemeA.caseInsensitiveCompare(schemeB) == .orderedSame else {
        return false
    }
    guard let hostA = a.host, let hostB = b.host, hostA.caseInsensitiveCompare(hostB) == .orderedSame else {
        return false
    }
    return port(a) == port(b)
}

private func port(_ url: URLComponents) -> Int {
    if let port = url.port { return port }
    return url.scheme?.lowercased() == "https" ? 443 : 80
}

private func trimTrailingSlashes(_ text: String) -> String {
    var text = Substring(text)
    while text.hasSuffix("/") { text = text.dropLast() }
    return String(text)
}
