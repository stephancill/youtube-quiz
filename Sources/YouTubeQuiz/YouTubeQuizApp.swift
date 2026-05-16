import SwiftUI
import UserNotifications
import YouTubeQuizCore

#if os(iOS)
    import UIKit
#endif

@main
struct YouTubeQuizApp: App {
    #if os(iOS)
        @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

#if os(iOS)
    final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
        func application(
            _: UIApplication,
            didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]? = nil
        ) -> Bool {
            UNUserNotificationCenter.current().delegate = self
            return true
        }

        func application(_: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
            let token = deviceToken.map { String(format: "%02x", $0) }.joined()
            Task { @MainActor in
                await NotificationRegistration.shared.registerDeviceToken(token)
            }
        }

        func application(_: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
            Task { @MainActor in
                NotificationRegistration.shared.registrationError = error.localizedDescription
            }
        }
    }
#endif
