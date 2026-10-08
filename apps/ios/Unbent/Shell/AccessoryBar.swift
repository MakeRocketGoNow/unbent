import ObjectiveC
import UIKit
import WebKit

extension WKWebView {
    /// Takes away the bar WebKit puts above the keyboard: previous field, next field, done.
    ///
    /// It is a form assistant, for stepping through the inputs of a web form. In the
    /// editor there is one field, so its arrows go nowhere, and it costs a row of screen
    /// directly above the keys — the row the editor's own toolbar is docked to. Safari
    /// has it because Safari does not know what page it is showing; this app does.
    ///
    /// WebKit offers no switch for it. The bar is the `inputAccessoryView` of the private
    /// view that takes the keyboard's input, so the only way to remove it is to make that
    /// one view an instance of a subclass, made here at run time, whose accessory is nil.
    /// No private method is called and the property overridden is `UIResponder`'s own,
    /// but the view is found by the start of its class's name, `WKContent`, and that name
    /// is WebKit's private business. This is a dependency on WebKit's internals. It is
    /// the same one Capacitor's Keyboard plugin and Cordova's before it take to hide this
    /// bar, in apps that pass review, but it is not a promise Apple has made. If a future
    /// WebKit renames or rearranges its views this finds nothing and the bar comes back,
    /// which is the failure worth having — and it says so, by returning false, so the
    /// caller can put it in the log rather than wait for a screenshot.
    ///
    /// The bar's tick put the keyboard away. The editor's docked toolbar has a button for
    /// that instead (`EditorToolbar.tsx`), and a tap outside the text — the note's
    /// fields, its head — still does it, as it always did. Dragging the keyboard down, as
    /// in Notes, was tried through the scroll view's `keyboardDismissMode` and does
    /// nothing here: the note scrolls in a column of the page's own, so the web view's
    /// scroll view never moves.
    func removeInputAccessoryBar() -> Bool {
        guard
            let content = scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }),
            let original = object_getClass(content)
        else { return false }

        let name = "\(NSStringFromClass(original))_UnbentNoAccessory"
        if let existing = NSClassFromString(name) {
            object_setClass(content, existing)
            return true
        }
        guard
            let subclass = objc_allocateClassPair(original, name, 0),
            let getter = class_getInstanceMethod(NoAccessory.self, #selector(getter: NoAccessory.inputAccessoryView))
        else { return false }
        class_addMethod(
            subclass,
            #selector(getter: UIResponder.inputAccessoryView),
            method_getImplementation(getter),
            method_getTypeEncoding(getter)
        )
        objc_registerClassPair(subclass)
        object_setClass(content, subclass)
        return true
    }
}

/// Where the replacement getter is written, so it can be written in Swift.
private final class NoAccessory: UIView {
    override var inputAccessoryView: UIView? { nil }
}
