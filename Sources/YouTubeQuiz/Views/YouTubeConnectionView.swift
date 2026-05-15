import AuthenticationServices
import SwiftUI
import YouTubeQuizCore

struct YouTubeConnectionView: View {
    @ObservedObject var viewModel: YouTubeConnectionViewModel
    @State private var showingLoginSheet = false
    @State private var showingCookieHeader = false

    var body: some View {
        Form {
            Section("Server") {
                TextField("Server URL", text: $viewModel.serverBaseURLString)
                #if os(iOS)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                #endif

                HStack {
                    Text("Account")
                    Spacer()
                    Text(viewModel.authLabel)
                        .foregroundStyle(.secondary)
                }

                if viewModel.appSession == nil {
                    SignInWithAppleButton(.signIn) { request in
                        request.requestedScopes = [.email]
                    } onCompletion: { result in
                        handleAppleSignIn(result)
                    }
                    .frame(height: 44)
                } else {
                    Button("Sign Out", role: .destructive) {
                        viewModel.signOut()
                    }
                }
            }

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
        .navigationTitle("YouTube Quiz")
        .task {
            await viewModel.load()
        }
        .sheet(isPresented: $showingLoginSheet) {
            YouTubeLoginWebView { credentials in
                Task { await viewModel.save(credentials) }
            }
        }
    }

    private func handleAppleSignIn(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case let .success(authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let identityToken = credential.identityToken,
                  let identityTokenString = String(data: identityToken, encoding: .utf8)
            else {
                viewModel.message = "Apple did not return an identity token."
                return
            }

            Task { await viewModel.signInWithApple(identityToken: identityTokenString) }
        case let .failure(error):
            viewModel.message = error.localizedDescription
        }
    }
}
