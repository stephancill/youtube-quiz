import Foundation
import Security

public enum KeychainCredentialStoreError: LocalizedError {
    case unhandledStatus(OSStatus)

    public var errorDescription: String? {
        switch self {
        case let .unhandledStatus(status):
            "Keychain error \(status)."
        }
    }
}

public final class KeychainCredentialStore {
    private let service: String
    private let fallbackStore: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(
        service: String = "tech.stupid.YouTubeQuiz.credentials",
        fallbackStore: UserDefaults = .standard
    ) {
        self.service = service
        self.fallbackStore = fallbackStore
    }

    public func saveYouTubeCredentials(_ credentials: YouTubeCredentials) throws {
        let data = try encoder.encode(credentials)
        try save(data: data, account: "youtube")
    }

    public func loadYouTubeCredentials() throws -> YouTubeCredentials? {
        guard let data = try load(account: "youtube") else { return nil }
        return try decoder.decode(YouTubeCredentials.self, from: data)
    }

    public func deleteYouTubeCredentials() throws {
        for synchronizable in synchronizableCandidates {
            let status = SecItemDelete(baseQuery(account: "youtube", synchronizable: synchronizable) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { continue }
        }
        fallbackStore.removeObject(forKey: fallbackKey(account: "youtube"))
    }

    public func saveAppSession(_ session: AppSession) throws {
        let data = try encoder.encode(session)
        try save(data: data, account: "app-session")
    }

    public func loadAppSession() throws -> AppSession? {
        guard let data = try load(account: "app-session") else { return nil }
        let session = try decoder.decode(AppSession.self, from: data)
        guard session.expiresAt > Date() else {
            try deleteAppSession()
            return nil
        }
        return session
    }

    public func deleteAppSession() throws {
        for synchronizable in synchronizableCandidates {
            let status = SecItemDelete(baseQuery(account: "app-session", synchronizable: synchronizable) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { continue }
        }
        fallbackStore.removeObject(forKey: fallbackKey(account: "app-session"))
    }

    private func save(data: Data, account: String) throws {
        do {
            try save(data: data, account: account, synchronizable: preferredSynchronizable)
            fallbackStore.removeObject(forKey: fallbackKey(account: account))
        } catch {
            do {
                try save(data: data, account: account, synchronizable: false)
                fallbackStore.removeObject(forKey: fallbackKey(account: account))
            } catch {
                fallbackStore.set(data, forKey: fallbackKey(account: account))
            }
        }
    }

    private func save(data: Data, account: String, synchronizable: Bool) throws {
        var query = baseQuery(account: account, synchronizable: synchronizable)
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)

        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else {
            throw KeychainCredentialStoreError.unhandledStatus(status)
        }

        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainCredentialStoreError.unhandledStatus(addStatus)
        }
    }

    private func load(account: String) throws -> Data? {
        for synchronizable in synchronizableCandidates {
            var query = baseQuery(account: account, synchronizable: synchronizable)
            query[kSecReturnData as String] = kCFBooleanTrue
            query[kSecMatchLimit as String] = kSecMatchLimitOne

            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)

            if status == errSecItemNotFound { continue }
            if status == errSecSuccess {
                return item as? Data
            }
        }

        return fallbackStore.data(forKey: fallbackKey(account: account))
    }

    private func baseQuery(account: String, synchronizable: Bool) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: synchronizable ? kCFBooleanTrue as Any : kCFBooleanFalse as Any,
        ]
    }

    private var preferredSynchronizable: Bool {
        #if targetEnvironment(simulator)
            false
        #else
            true
        #endif
    }

    private var synchronizableCandidates: [Bool] {
        preferredSynchronizable ? [true, false] : [false, true]
    }

    private func fallbackKey(account: String) -> String {
        "\(service).\(account).localFallback"
    }
}
