import Foundation

public struct AppSession: Codable, Equatable, Sendable {
    public let sessionToken: String
    public let expiresAt: Date
    public let user: AppUser

    public init(sessionToken: String, expiresAt: Date, user: AppUser) {
        self.sessionToken = sessionToken
        self.expiresAt = expiresAt
        self.user = user
    }
}

public struct AppUser: Codable, Equatable, Sendable {
    public let id: Int
    public let email: String?
    public let youtubeLinked: Bool

    public init(id: Int, email: String?, youtubeLinked: Bool) {
        self.id = id
        self.email = email
        self.youtubeLinked = youtubeLinked
    }
}

public final class QuizServerClient: Sendable {
    private let baseURL: URL
    private let urlSession: URLSession
    private let decoder: JSONDecoder
    private let encoder = JSONEncoder()

    public init(baseURL: URL, urlSession: URLSession = .shared) {
        self.baseURL = baseURL
        self.urlSession = urlSession
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder
        encoder.dateEncodingStrategy = .iso8601
    }

    public func signInWithApple(identityToken: String) async throws -> AppSession {
        let response: AuthResponse = try await sendJSON(
            path: "/auth/apple",
            method: "POST",
            bearerToken: nil,
            body: ["identityToken": identityToken]
        )
        return AppSession(
            sessionToken: response.sessionToken,
            expiresAt: response.expiresAt,
            user: response.user
        )
    }

    public func uploadYouTubeCookies(cookieHeader: String, sessionToken: String) async throws {
        let _: UploadCookiesResponse = try await sendJSON(
            path: "/youtube/cookies",
            method: "PUT",
            bearerToken: sessionToken,
            body: ["cookieHeader": cookieHeader]
        )
    }

    private func sendJSON<RequestBody: Encodable, ResponseBody: Decodable>(
        path: String,
        method: String,
        bearerToken: String?,
        body: RequestBody
    ) async throws -> ResponseBody {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "authorization")
        }
        request.httpBody = try encoder.encode(body)

        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw QuizServerClientError.invalidResponse
        }
        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            let errorBody = try? decoder.decode(ErrorResponse.self, from: data)
            throw QuizServerClientError.requestFailed(
                statusCode: httpResponse.statusCode,
                message: errorBody?.error
            )
        }

        return try decoder.decode(ResponseBody.self, from: data)
    }
}

public enum QuizServerClientError: LocalizedError {
    case invalidResponse
    case requestFailed(statusCode: Int, message: String?)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "Invalid server response."
        case let .requestFailed(statusCode, message):
            message ?? "Server request failed with \(statusCode)."
        }
    }
}

private struct AuthResponse: Decodable {
    let sessionToken: String
    let expiresAt: Date
    let user: AppUser
}

private struct UploadCookiesResponse: Decodable {
    let youtubeLinked: Bool
}

private struct ErrorResponse: Decodable {
    let error: String
}
