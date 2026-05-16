import Foundation

@MainActor
public final class YouTubeConnectionViewModel: ObservableObject {
    @Published public private(set) var credentials: YouTubeCredentials?
    @Published public private(set) var appSession: AppSession?
    @Published public private(set) var quizzes: [AvailableQuiz] = []
    @Published public private(set) var quizHistory: [AvailableQuiz] = []
    @Published public private(set) var isLoadingQuizzes = false
    @Published public var message: String?

    private let credentialStore: KeychainCredentialStore
    public let serverBaseURLString: String

    public init(
        credentialStore: KeychainCredentialStore = KeychainCredentialStore(),
        serverBaseURLString: String = ServerConfig.baseURLString
    ) {
        self.credentialStore = credentialStore
        self.serverBaseURLString = serverBaseURLString
        NotificationRegistration.shared.configure(
            sessionProvider: { [weak self] in self?.appSession },
            clientProvider: { [weak self] in
                guard let self else { throw URLError(.badURL) }
                return try self.makeServerClient()
            }
        )
    }

    public var connectionLabel: String {
        credentials == nil ? "Not configured" : "Connected"
    }

    public var authLabel: String {
        appSession == nil ? "Not signed in" : "Signed in"
    }

    public var cookieHeader: String {
        guard let credentials else { return "" }
        return credentials.cookieHeader
    }

    public var isYouTubeLinked: Bool {
        appSession?.user.youtubeLinked == true
    }

    public func load() async {
        do {
            credentials = try credentialStore.loadYouTubeCredentials()
            appSession = try credentialStore.loadAppSession()
            message = nil
            await refreshCurrentUser()
        } catch {
            message = error.localizedDescription
        }
    }

    public func signInWithApple(identityToken: String) async {
        do {
            let client = try makeServerClient()
            let session = try await client.signInWithApple(identityToken: identityToken)
            try credentialStore.saveAppSession(session)
            appSession = session
            message = "Signed in with Apple."
        } catch {
            message = error.localizedDescription
        }
    }

    public func save(_ credentials: YouTubeCredentials) async {
        do {
            guard let appSession else {
                message = "Sign in with Apple before connecting YouTube."
                return
            }

            try credentialStore.saveYouTubeCredentials(credentials)
            self.credentials = credentials
            try await upload(credentials: credentials, appSession: appSession)
            message = "YouTube is connected and uploaded to the quiz server."
        } catch {
            message = "Saved YouTube cookies locally, but upload failed: \(error.localizedDescription)"
        }
    }

    public func uploadSavedCredentials() async {
        do {
            guard let credentials else {
                message = "Log in to YouTube before uploading cookies."
                return
            }

            guard let appSession else {
                message = "Sign in with Apple before uploading cookies."
                return
            }

            try await upload(credentials: credentials, appSession: appSession)
            message = "YouTube cookies uploaded to the quiz server."
        } catch {
            message = error.localizedDescription
        }
    }

    public func disconnect() {
        do {
            try credentialStore.deleteYouTubeCredentials()
            credentials = nil
            if let appSession {
                let disconnectedUser = AppUser(
                    id: appSession.user.id,
                    email: appSession.user.email,
                    youtubeLinked: false,
                    notificationsEnabled: appSession.user.notificationsEnabled
                )
                let disconnectedSession = AppSession(
                    sessionToken: appSession.sessionToken,
                    expiresAt: appSession.expiresAt,
                    user: disconnectedUser
                )
                try credentialStore.saveAppSession(disconnectedSession)
                self.appSession = disconnectedSession
            }
            message = "YouTube is disconnected."
        } catch {
            message = error.localizedDescription
        }
    }

    public func disconnectYouTube() async {
        do {
            guard let appSession else { return }
            let client = try makeServerClient()
            let user = try await client.disconnectYouTube(sessionToken: appSession.sessionToken)
            try credentialStore.deleteYouTubeCredentials()
            credentials = nil
            quizzes = []
            quizHistory = []
            try saveSession(user: user, existingSession: appSession)
            message = "YouTube is disconnected."
        } catch {
            message = error.localizedDescription
        }
    }

    public func setNotificationsEnabled(_ enabled: Bool) async {
        do {
            guard let appSession else { return }
            let client = try makeServerClient()
            let user = try await client.updateNotifications(
                enabled: enabled,
                sessionToken: appSession.sessionToken
            )
            try saveSession(user: user, existingSession: appSession)
            message = enabled ? "Notifications enabled." : "Notifications disabled."
        } catch {
            message = error.localizedDescription
        }
    }

    public func signOut() {
        do {
            try credentialStore.deleteAppSession()
            appSession = nil
            quizzes = []
            quizHistory = []
            message = "Signed out."
        } catch {
            message = error.localizedDescription
        }
    }

    public func loadQuizzes() async {
        guard let appSession else { return }
        isLoadingQuizzes = true
        defer { isLoadingQuizzes = false }

        do {
            let client = try makeServerClient()
            let list = try await client.listAvailableQuizzes(sessionToken: appSession.sessionToken)
            quizzes = list.quizzes
            quizHistory = list.history
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    public func quizDetail(quizId: Int) async throws -> AppQuizDetail {
        guard let appSession else { throw URLError(.userAuthenticationRequired) }
        let client = try makeServerClient()
        return try await client.quizDetail(quizId: quizId, sessionToken: appSession.sessionToken)
    }

    public func submitAnswer(quizId: Int, answer: String) async throws -> AppAnswerResult {
        guard let appSession else { throw URLError(.userAuthenticationRequired) }
        let client = try makeServerClient()
        let result = try await client.submitAnswer(
            quizId: quizId,
            answer: answer,
            sessionToken: appSession.sessionToken
        )
        await loadQuizzes()
        return result
    }

    private func makeServerClient() throws -> QuizServerClient {
        guard let baseURL = URL(string: serverBaseURLString), baseURL.scheme != nil else {
            throw URLError(.badURL)
        }
        return QuizServerClient(baseURL: baseURL)
    }

    private func upload(credentials: YouTubeCredentials, appSession: AppSession) async throws {
        let client = try makeServerClient()
        try await client.uploadYouTubeCookies(
            cookieHeader: credentials.cookieHeader,
            sessionToken: appSession.sessionToken
        )
        let linkedUser = AppUser(
            id: appSession.user.id,
            email: appSession.user.email,
            youtubeLinked: true,
            notificationsEnabled: appSession.user.notificationsEnabled
        )
        try saveSession(user: linkedUser, existingSession: appSession)
    }

    private func refreshCurrentUser() async {
        guard let appSession else { return }

        do {
            let client = try makeServerClient()
            let user = try await client.me(sessionToken: appSession.sessionToken)
            try saveSession(user: user, existingSession: appSession)
        } catch {
            try? credentialStore.deleteAppSession()
            self.appSession = nil
            message = "Sign in again to continue."
        }
    }

    private func saveSession(user: AppUser, existingSession: AppSession) throws {
        let session = AppSession(
            sessionToken: existingSession.sessionToken,
            expiresAt: existingSession.expiresAt,
            user: user
        )
        try credentialStore.saveAppSession(session)
        appSession = session
    }
}
