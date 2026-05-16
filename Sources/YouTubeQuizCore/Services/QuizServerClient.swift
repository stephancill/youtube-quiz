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
    public let notificationsEnabled: Bool

    public init(id: Int, email: String?, youtubeLinked: Bool, notificationsEnabled: Bool) {
        self.id = id
        self.email = email
        self.youtubeLinked = youtubeLinked
        self.notificationsEnabled = notificationsEnabled
    }
}

public struct AvailableQuiz: Codable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let videoTitle: String
    public let currentQuestionIndex: Int
    public let questionCount: Int
    public let score: Double
    public let status: String

    public init(id: Int, videoTitle: String, currentQuestionIndex: Int, questionCount: Int, score: Double, status: String) {
        self.id = id
        self.videoTitle = videoTitle
        self.currentQuestionIndex = currentQuestionIndex
        self.questionCount = questionCount
        self.score = score
        self.status = status
    }
}

public struct QuizList: Codable, Equatable, Sendable {
    public let quizzes: [AvailableQuiz]
    public let history: [AvailableQuiz]
}

public struct AppQuizDetail: Codable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let videoId: String
    public let videoTitle: String
    public let currentQuestionIndex: Int
    public let questionCount: Int
    public let score: Double
    public let status: String
    public let currentQuestion: AppQuizQuestion?
    public let questions: [AppQuizCompletedQuestion]
}

public struct AppQuizQuestion: Codable, Equatable, Sendable {
    public let prompt: String
    public let sourceTimestamp: String
    public let hint: String?
}

public struct AppQuizCompletedQuestion: Codable, Equatable, Sendable, Identifiable {
    public var id: String {
        "\(sourceTimestamp)-\(prompt)"
    }

    public let prompt: String
    public let correctAnswer: String
    public let sourceTimestamp: String
    public let hint: String?
    public let result: AppQuizQuestionResult?
}

public struct AppQuizQuestionResult: Codable, Equatable, Sendable {
    public let userAnswer: String
    public let score: Double
    public let feedback: String
}

public struct AppAnswerResult: Codable, Equatable, Sendable {
    public let grade: AppGradeResult
    public let completed: Bool
    public let quiz: AppQuizDetail?
}

public struct AppGradeResult: Codable, Equatable, Sendable {
    public let score: Double
    public let feedback: String
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

    public func disconnectYouTube(sessionToken: String) async throws -> AppUser {
        let response: MeResponse = try await sendJSON(
            path: "/youtube/cookies",
            method: "DELETE",
            bearerToken: sessionToken,
            body: EmptyRequestBody()
        )
        return response.user
    }

    public func updateNotifications(enabled: Bool, sessionToken: String) async throws -> AppUser {
        let response: MeResponse = try await sendJSON(
            path: "/settings/notifications",
            method: "PUT",
            bearerToken: sessionToken,
            body: ["notificationsEnabled": enabled]
        )
        return response.user
    }

    public func registerDeviceToken(token: String, sessionToken: String) async throws {
        let _: EmptyResponse = try await sendJSON(
            path: "/settings/device-token",
            method: "POST",
            bearerToken: sessionToken,
            body: ["token": token]
        )
    }

    public func me(sessionToken: String) async throws -> AppUser {
        let response: MeResponse = try await sendJSON(
            path: "/me",
            method: "GET",
            bearerToken: sessionToken,
            body: EmptyRequestBody()
        )
        return response.user
    }

    public func listAvailableQuizzes(sessionToken: String) async throws -> QuizList {
        try await sendJSON(
            path: "/quizzes",
            method: "GET",
            bearerToken: sessionToken,
            body: EmptyRequestBody()
        )
    }

    public func quizDetail(quizId: Int, sessionToken: String) async throws -> AppQuizDetail {
        let response: QuizDetailResponse = try await sendJSON(
            path: "/quizzes/\(quizId)",
            method: "GET",
            bearerToken: sessionToken,
            body: EmptyRequestBody()
        )
        return response.quiz
    }

    public func submitAnswer(quizId: Int, answer: String, sessionToken: String) async throws -> AppAnswerResult {
        try await sendJSON(
            path: "/quizzes/\(quizId)/answer",
            method: "POST",
            bearerToken: sessionToken,
            body: ["answer": answer]
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
        if method != "GET" {
            request.httpBody = try encoder.encode(body)
        }

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

private struct MeResponse: Decodable {
    let user: AppUser
}

private struct QuizDetailResponse: Decodable {
    let quiz: AppQuizDetail
}

private struct EmptyRequestBody: Encodable {}

private struct EmptyResponse: Decodable {}

private struct ErrorResponse: Decodable {
    let error: String
}
