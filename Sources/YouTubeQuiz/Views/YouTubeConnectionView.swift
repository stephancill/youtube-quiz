import SwiftUI
import YouTubeQuizCore

struct YouTubeConnectionView: View {
    @ObservedObject var viewModel: YouTubeConnectionViewModel
    @State private var showingLoginSheet = false
    @State private var showingCookieHeader = false

    var body: some View {
        Form {
            Section {
                HStack {
                    Text("Connection")
                    Spacer()
                    Text(viewModel.connectionLabel)
                        .foregroundStyle(.secondary)
                }
            }

            if viewModel.credentials == nil {
                Section {
                    Button {
                        showingLoginSheet = true
                    } label: {
                        HStack {
                            Spacer()
                            Label("Log in to YouTube", systemImage: "safari")
                            Spacer()
                        }
                    }
                    .disabled(viewModel.appSession == nil)
                }
            } else {
                Section {
                    Button {
                        Task { await viewModel.uploadSavedCredentials() }
                    } label: {
                        Label("Upload Saved Cookies", systemImage: "arrow.up.doc")
                    }

                    Button {
                        showingCookieHeader.toggle()
                    } label: {
                        Label(showingCookieHeader ? "Hide Cookie Header" : "Show Cookie Header", systemImage: "key")
                    }

                    if showingCookieHeader {
                        Text(viewModel.cookieHeader)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                    }
                } footer: {
                    Text("Treat this like a password. Send it to the bot only after /link.")
                }

                Section {
                    Button("Disconnect", role: .destructive) {
                        viewModel.disconnect()
                    }
                }
            }

            if let message = viewModel.message {
                Section {
                    Text(message)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Connect YouTube")
        .sheet(isPresented: $showingLoginSheet) {
            YouTubeLoginWebView { credentials in
                Task { await viewModel.save(credentials) }
            }
        }
    }
}
