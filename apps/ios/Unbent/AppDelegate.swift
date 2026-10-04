import UIKit
import UnbentCore
import UnbentUI
import UserNotifications

/// UIKit's lifecycle, not SwiftUI's `App`, and on purpose.
///
/// The app is one web view, and what it needs from the system is all UIKit's to give: a
/// status bar whose style follows the page's colour, a layout guide for the keyboard, a
/// place to present Safari and the alerts the page raises. Under a SwiftUI `App` each of
/// those is reached by working around the hosting controller. The native screens are
/// SwiftUI all the same — `UnbentUI` — and are hosted where they are shown.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    /// The screen a tapped notification or an opened file is handed to. Weak, and set by
    /// the scene: the app can be launched in the background with no scene at all, for a
    /// capture's upload, and there is then nothing to show anything on.
    static weak var root: RootViewController?

    /// A note to open, from a notification tapped before there was a screen to open it.
    static var pendingPath: String?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Before launch finishes, or a notification that launched the app is delivered
        // to nobody.
        UNUserNotificationCenter.current().delegate = self
        // Every launch, the background ones included: the system does not relaunch an
        // app the person force-quit to tell it an upload finished, so what is on disk
        // is looked at whenever the app runs at all.
        AppCaptures.queue?.sweep()
        AppCaptures.queue?.resumeAll()
        return true
    }

    /// Requests of a capture finished while the app was not running. Joining the session
    /// delivers their results, and the queue calls `completionHandler` once it has
    /// applied them — which is the system's cue to suspend the app again.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        if AppCaptures.queue?.handleEvents(identifier: identifier, completion: completionHandler) != true {
            completionHandler()
        }
    }

    /// Goes to `path` on the site, now or as soon as there is a screen.
    static func open(path: String) {
        if let root { root.open(path: path) } else { pendingPath = path }
    }
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    /// "Saved", tapped: the note it names.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let noteId = CaptureNotifications.noteId(in: response.notification.request.content.userInfo) else { return }
        await MainActor.run { AppDelegate.open(path: "/notes/\(noteId)") }
    }

    /// With the app on screen a notification is otherwise swallowed, and a file opened in
    /// the app is captured with the app on screen.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }
}

/// The app's capture queue: one, made on first use and kept, since it is the delegate of
/// a session the system delivers to for as long as the app runs. Nil for a build signed
/// without the App Group, which has nowhere for a capture to wait.
enum AppCaptures {
    static let signedOut = Notification.Name("unbent.capture.signedOut")

    static let queue: CaptureQueue? = {
        guard let store = Captures.store() else { return nil }
        return CaptureQueue(
            store: store,
            home: CaptureQueue.appSession(appId: BuildInfo.appId),
            role: .app,
            appGroup: BuildInfo.appGroup,
            sessions: Captures.sessions(),
            notifier: CaptureNotifications(),
            // A capture was refused for its session and the queue has forgotten it. The
            // screen showing that instance has to hear, or it carries on with a page
            // whose every request now fails.
            onSignedOut: { origin in
                DispatchQueue.main.async { NotificationCenter.default.post(name: signedOut, object: origin) }
            }
        )
    }()
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var root: RootViewController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let root = RootViewController()
        if let path = AppDelegate.pendingPath {
            AppDelegate.pendingPath = nil
            root.open(path: path)
        }
        // A link or a quick action that launched the app, before the window as the
        // notification's path above is: made key, the window loads the site at its home,
        // and a path given after that is a second load of the page instead of its first.
        options.userActivities.forEach(root.follow)
        if let item = options.shortcutItem { _ = root.perform(item) }
        AppDelegate.root = root
        let window = UIWindow(windowScene: scene)
        window.rootViewController = root
        window.tintColor = .unbentAccent
        window.makeKeyAndVisible()
        self.window = window
        self.root = root
        // A file that launched the app arrives here, not below.
        root.capture(options.urlContexts.map(\.url))
    }

    /// "Open in Unbent" from another app.
    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        root?.capture(contexts.map(\.url))
    }

    /// A link to the site, tapped in Mail, Messages or Safari, while the app was running.
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        root?.follow(userActivity)
    }

    /// A quick action from the Home Screen icon, while the app was running.
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(root?.perform(shortcutItem) ?? false)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        root?.becameActive()
        // A capture made while signed out, or one whose result the system did not
        // relaunch the app for, moves now.
        AppCaptures.queue?.resumeAll()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        root?.enteredBackground()
    }
}
