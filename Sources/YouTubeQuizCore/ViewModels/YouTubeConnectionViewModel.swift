import Foundation

@MainActor
public final class YouTubeConnectionViewModel: ObservableObject {
    @Published public private(set) var credentials: YouTubeCredentials?
    @Published public private(set) var appSession: AppSession?
    @Published public var message: String?
    @Published public var serverBaseURLString: String {
        didSet {
            settingsStore.set(serverBaseURLString, forKey: serverBaseURLStringKey)
        }
    }

    private let credentialStore: KeychainCredentialStore
    private let settingsStore: UserDefaults
    private let serverBaseURLStringKey = "serverBaseURLString"

    public init(
        credentialStore: KeychainCredentialStore = KeychainCredentialStore(),
        settingsStore: UserDefaults = .standard,
        serverBaseURLString: String = "http://127.0.0.1:3000"
    ) {
        self.credentialStore = credentialStore
        self.settingsStore = settingsStore
        self.serverBaseURLString = settingsStore.string(forKey: serverBaseURLStringKey) ?? serverBaseURLString
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

    public func load() async {
        do {
            credentials = try credentialStore.loadYouTubeCredentials()
            appSession = try credentialStore.loadAppSession()
            message = nil
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
            message = "YouTube is disconnected."
        } catch {
            message = error.localizedDescription
        }
    }

    public func signOut() {
        do {
            try credentialStore.deleteAppSession()
            appSession = nil
            message = "Signed out."
        } catch {
            message = error.localizedDescription
        }
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
    }
}
