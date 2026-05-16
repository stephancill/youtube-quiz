import AuthenticationServices
import SwiftUI
import YouTubeQuizCore

struct SignInView: View {
    @ObservedObject var viewModel: YouTubeConnectionViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Spacer(minLength: 32)

            VStack(alignment: .leading, spacing: 12) {
                Text("Turn your watch history into quick quizzes.")
                    .font(.largeTitle.weight(.bold))

                Text("Connect YouTube once, then practice remembering what you watched with short free-response questions.")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if let message = viewModel.message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            SignInWithAppleButton(.signIn) { request in
                request.requestedScopes = [.email]
            } onCompletion: { result in
                handleAppleSignIn(result)
            }
            .frame(height: 52)
        }
        .padding(24)
        .navigationTitle("YouTube Quiz")
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
