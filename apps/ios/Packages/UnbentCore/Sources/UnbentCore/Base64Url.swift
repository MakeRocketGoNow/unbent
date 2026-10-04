import Foundation

/// Base64 as WebAuthn and JWTs write it: `-` and `_` for `+` and `/`, and no padding.
///
/// Foundation reads and writes only the padded, `+/` form, and refuses the other outright
/// rather than guessing. A passkey's challenge and every field of its answer are this
/// form, so the conversion is here once instead of at each of them.
public extension Data {
    init?(base64Url text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        // A sender that pads is still read; one that does not is padded here.
        while base64.count % 4 != 0 { base64.append("=") }
        self.init(base64Encoded: base64)
    }

    var base64Url: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
