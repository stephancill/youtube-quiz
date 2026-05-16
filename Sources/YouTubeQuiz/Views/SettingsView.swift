import SwiftUI
import UserNotifications
import YouTubeQuizCore

#if os(iOS)
    import UIKit
#endif

struct SettingsView: View {
    @ObservedObject var viewModel: YouTubeConnectionViewModel
    @State private var notificationsEnabled = false
    @State private var isUpdatingNotifications = false

    var body: some View {
        Form {
            Section("Account") {
                LabeledContent("Signed in as") {
                    Text(viewModel.appSession?.user.email ?? "Unknown")
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            Section("YouTube") {
                LabeledContent("Connection") {
                    Text(viewModel.isYouTubeLinked ? "Connected" : "Disconnected")
                        .foregroundStyle(.secondary)
                }

                if viewModel.isYouTubeLinked {
                    Button("Disconnect YouTube", role: .destructive) {
                        Task { await viewModel.disconnectYouTube() }
                    }
                }
            }

            Section {
                Toggle("Enable notifications", isOn: Binding(
                    get: { notificationsEnabled },
                    set: { newValue in
                        notificationsEnabled = newValue
                        Task { await updateNotifications(enabled: newValue) }
                    }
                ))
                .disabled(isUpdatingNotifications)
            } header: {
                Text("Notifications")
            } footer: {
                Text("The server stores this preference for quiz notifications. Device push delivery will be wired separately when APNs device token registration is added.")
            }

            Section {
                Button("Sign Out", role: .destructive) {
                    viewModel.signOut()
                }
            }

            if let message = viewModel.message {
                Section {
                    Text(message)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Settings")
        .onAppear {
            notificationsEnabled = viewModel.appSession?.user.notificationsEnabled == true
        }
    }

    private func updateNotifications(enabled: Bool) async {
        isUpdatingNotifications = true
        defer { isUpdatingNotifications = false }

        if enabled {
            let granted = await requestNotificationPermission()
            guard granted else {
                notificationsEnabled = false
                await viewModel.setNotificationsEnabled(false)
                return
            }
        }

        await viewModel.setNotificationsEnabled(enabled)
        if enabled, viewModel.appSession?.user.notificationsEnabled == true {
            #if os(iOS)
                UIApplication.shared.registerForRemoteNotifications()
            #endif
        }
        notificationsEnabled = viewModel.appSession?.user.notificationsEnabled == true
    }

    private func requestNotificationPermission() async -> Bool {
        do {
            return try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
        } catch {
            return false
        }
    }
}
