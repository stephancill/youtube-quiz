import Foundation

@MainActor
public final class NotificationRegistration: ObservableObject {
    public static let shared = NotificationRegistration()

    @Published public var registrationError: String?

    private var sessionProvider: (() -> AppSession?)?
    private var clientProvider: (() throws -> QuizServerClient)?

    private init() {}

    public func configure(
        sessionProvider: @escaping () -> AppSession?,
        clientProvider: @escaping () throws -> QuizServerClient
    ) {
        self.sessionProvider = sessionProvider
        self.clientProvider = clientProvider
    }

    public func registerDeviceToken(_ token: String) async {
        do {
            guard let session = sessionProvider?() else { return }
            guard let client = try clientProvider?() else { return }
            try await client.registerDeviceToken(token: token, sessionToken: session.sessionToken)
            registrationError = nil
        } catch {
            registrationError = error.localizedDescription
        }
    }
}
