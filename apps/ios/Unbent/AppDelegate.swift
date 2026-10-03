import UIKit
import UnbentUI

/// UIKit's lifecycle, not SwiftUI's `App`, and on purpose.
///
/// The app is one web view, and what it needs from the system is all UIKit's to give: a
/// status bar whose style follows the page's colour, a layout guide for the keyboard, a
/// place to present Safari and the alerts the page raises. Under a SwiftUI `App` each of
/// those is reached by working around the hosting controller. The native screens are
/// SwiftUI all the same — `UnbentUI` — and are hosted where they are shown.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var root: RootViewController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let root = RootViewController()
        let window = UIWindow(windowScene: scene)
        window.rootViewController = root
        window.tintColor = .unbentAccent
        window.makeKeyAndVisible()
        self.window = window
        self.root = root
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        root?.becameActive()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        root?.enteredBackground()
    }
}
