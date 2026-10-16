import QuickLook
import SafariServices
import UIKit
import UnbentUI

/// Safari's sheet over the app, for a web page that is not this site.
///
/// The iOS answer to Android's Custom Tab: the page gets a real browser (its own cookies,
/// an address bar, Reader) and none of this app's session, and Done comes back to the
/// note that linked to it.
enum SFSafari {
    static func controller(for url: URL) -> SFSafariViewController {
        let safari = SFSafariViewController(url: url)
        safari.preferredControlTintColor = .unbentAccent
        return safari
    }
}

/// Quick Look, for a file the app has just saved: Open on the banner shows it without
/// leaving the app, which is what Android's "download complete" notification does by
/// handing the file to whatever views that type.
enum FilePreview {
    static func controller(for url: URL) -> QLPreviewController {
        let source = Source(url: url)
        let preview = QLPreviewController()
        preview.dataSource = source
        // The controller does not keep its data source; tied to it here so the two go
        // together.
        objc_setAssociatedObject(preview, &sourceKey, source, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return preview
    }

    private static var sourceKey: UInt8 = 0

    private final class Source: NSObject, QLPreviewControllerDataSource {
        let url: URL

        init(url: URL) {
            self.url = url
        }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}
