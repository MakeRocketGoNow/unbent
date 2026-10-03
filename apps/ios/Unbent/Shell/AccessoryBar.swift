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
    /// Nothing private is named or called: the view is found by being the scroll view's
    /// content view, and the property overridden is `UIResponder`'s own. If a future
    /// WebKit arranges its views differently this finds nothing and the bar comes back,
    /// which is the failure worth having.
    ///
    /// The bar's tick put the keyboard away. Without it, a tap anywhere outside the text
    /// does — the note's fields, its head — which is what the page already did. Dragging
    /// the keyboard down, as in Notes, was tried through the scroll view's
    /// `keyboardDismissMode` and does nothing here: the note scrolls in a column of the
    /// page's own, so the web view's scroll view never moves.
    func removeInputAccessoryBar() {
        guard
            let content = scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }),
            let original = object_getClass(content)
        else { return }

        let name = "\(NSStringFromClass(original))_UnbentNoAccessory"
        if let existing = NSClassFromString(name) {
            object_setClass(content, existing)
            return
        }
        guard
            let subclass = objc_allocateClassPair(original, name, 0),
            let getter = class_getInstanceMethod(NoAccessory.self, #selector(getter: NoAccessory.inputAccessoryView))
        else { return }
        class_addMethod(
            subclass,
            #selector(getter: UIResponder.inputAccessoryView),
            method_getImplementation(getter),
            method_getTypeEncoding(getter)
        )
        objc_registerClassPair(subclass)
        object_setClass(content, subclass)
    }
}

/// Where the replacement getter is written, so it can be written in Swift.
private final class NoAccessory: UIView {
    override var inputAccessoryView: UIView? { nil }
}
