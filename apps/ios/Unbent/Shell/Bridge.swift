import WebKit

/// The app's end of the bridge: the script that puts `window.UnbentApp` on the page, and
/// the names it talks back on.
///
/// Android installs that object with `addJavascriptInterface`, whose methods answer
/// synchronously. A WKWebView has nothing like it — a page can only post to a message
/// handler — so the object is made by a script of the app's own, run before any of the
/// page's, and what the page calls is the same either way (apps/web/src/app-bridge.ts).
/// The `save` calls go to a handler that replies, which reaches the page as a promise;
/// the page was taught to wait for one in MAK-150.
enum Bridge {
    /// One-way messages from the page: `BridgeMessage`, as JSON text.
    static let messages = "unbent"

    /// The export's calls, each answered: `{op: begin|chunk|end|abort, …}`.
    static let saves = "unbentSave"

    /// Debug builds only: the page's errors, for the Mac's log.
    static let log = "unbentLog"

    /// Installs `window.UnbentApp`. Frozen, so nothing on the page can swap a method for
    /// one of its own, and `platform` says which host this is — Android's object cannot,
    /// so a host that says nothing is Android.
    static let script = WKUserScript(
        source: """
        (function () {
          if (window.UnbentApp) return;
          var handlers = window.webkit.messageHandlers;
          function save(message) { return handlers.\(saves).postMessage(message); }
          window.UnbentApp = Object.freeze({
            platform: 'ios',
            postMessage: function (json) { handlers.\(messages).postMessage(String(json)); },
            saveBegin: function (name, type) { return save({ op: 'begin', name: String(name), type: String(type) }); },
            saveChunk: function (id, base64) { return save({ op: 'chunk', id: String(id), data: String(base64) }); },
            saveEnd: function (id) { return save({ op: 'end', id: String(id) }); },
            saveAbort: function (id) { return save({ op: 'abort', id: String(id) }).then(function () {}); }
          });
        })();
        """,
        injectionTime: .atDocumentStart,
        // The main frame only. The site has no frames, and one that ever loads another
        // origin must not find the app's bridge waiting in it.
        forMainFrameOnly: true
    )

    /// Sends what the page logs as an error, and what it throws, to the unified log, where
    /// `xcrun simctl spawn booted log stream` shows it. Without this a page failing inside
    /// the app says so only to a Safari Web Inspector someone has to have open already.
    static let logScript = WKUserScript(
        source: """
        (function () {
          var handler = window.webkit.messageHandlers.\(log);
          function text(value) {
            if (value instanceof Error) return value.stack || String(value);
            if (typeof value === 'string') return value;
            try { return JSON.stringify(value); } catch (e) { return String(value); }
          }
          function send(parts) { try { handler.postMessage(parts.map(text).join(' ')); } catch (e) {} }
          var error = console.error;
          console.error = function () {
            send(Array.prototype.slice.call(arguments));
            return error.apply(console, arguments);
          };
          window.addEventListener('error', function (event) {
            send(['Uncaught', event.error || event.message]);
          });
          window.addEventListener('unhandledrejection', function (event) {
            send(['Unhandled rejection', event.reason]);
          });
        })();
        """,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    /// Asks the page to do something through `window.__unbent` and say whether it did.
    /// False when the page has nothing registered: still loading, or a deploy from before
    /// the call existed.
    static func ask(_ call: String) -> String {
        "(function(){var u=window.__unbent;return !!(u&&u.\(call));})()"
    }

    /// `text` as a JavaScript string literal. JSON's strings are JavaScript's.
    static func quote(_ text: String) -> String {
        guard let data = try? JSONEncoder().encode(text), let json = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return json
    }
}

/// A message handler that does not keep its target alive.
///
/// `WKUserContentController` holds its handlers strongly, and the shell holds the web view
/// that holds the controller — handed the shell itself, that is a cycle, and a shell that
/// is replaced on sign-out would never be freed.
final class WeakMessageHandler: NSObject, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    typealias Target = WKScriptMessageHandler & WKScriptMessageHandlerWithReply
    private weak var target: Target?

    init(_ target: Target) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let target else { return replyHandler(nil, "The app is no longer listening.") }
        target.userContentController(controller, didReceive: message, replyHandler: replyHandler)
    }
}
