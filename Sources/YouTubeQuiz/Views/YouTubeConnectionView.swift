import SwiftUI
import YouTubeQuizCore

struct YouTubeConnectionView: View {
    @ObservedObject var viewModel: YouTubeConnectionViewModel
    @State private var showingLoginSheet = false
    @State private var showingCookieHeader = false

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Spacer(minLength: 32)

            VStack(alignment: .leading, spacing: 12) {
                Text("Connect your YouTube history.")
                    .font(.largeTitle.weight(.bold))

                Text("Log in with YouTube so the app can save the cookies needed to find videos you have watched and turn them into quizzes.")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Connection")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)

                Text(viewModel.connectionLabel)
                    .font(.title3.weight(.semibold))
            }

            Spacer()

            if let message = viewModel.message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if viewModel.credentials == nil {
                Button {
                    showingLoginSheet = true
                } label: {
                    Label("Log in to YouTube", systemImage: "safari")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(viewModel.appSession == nil)
            } else {
                VStack(spacing: 12) {
                    Button {
                        Task { await viewModel.uploadSavedCredentials() }
                    } label: {
                        Label("Upload Saved Cookies", systemImage: "arrow.up.doc")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

                    Button {
                        showingCookieHeader.toggle()
                    } label: {
                        Label(showingCookieHeader ? "Hide Cookie Header" : "Show Cookie Header", systemImage: "key")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)

                    if showingCookieHeader {
                        Text(viewModel.cookieHeader)
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))

                        Text("Treat this like a password. Send it to the bot only after /link.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    Button("Disconnect", role: .destructive) {
                        viewModel.disconnect()
                    }
                    .frame(maxWidth: .infinity)
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                }
            }
        }
        .padding(24)
        .navigationTitle("Connect YouTube")
        .sheet(isPresented: $showingLoginSheet) {
            YouTubeLoginWebView { credentials in
                Task { await viewModel.save(credentials) }
            }
        }
    }
}
