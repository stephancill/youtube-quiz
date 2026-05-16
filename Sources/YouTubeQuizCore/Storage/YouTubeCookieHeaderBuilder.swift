import Foundation

public struct YouTubeCredentials: Codable, Equatable, Sendable {
    public let cookieHeader: String
    public let capturedAt: Date

    public init(cookieHeader: String, capturedAt: Date = Date()) {
        self.cookieHeader = cookieHeader
        self.capturedAt = capturedAt
    }
}

public enum YouTubeCookieHeaderBuilder {
    private static let authCookieNames: Set<String> = [
        "__Secure-1PSID",
        "__Secure-3PSID",
        "SAPISID",
        "APISID",
        "SID",
        "HSID",
        "SSID",
        "LOGIN_INFO",
    ]

    private static let includedDomains = [
        "youtube.com",
    ]

    public static func hasRequiredAuthCookies(_ cookies: [HTTPCookie]) -> Bool {
        let matchingNames = Set(authCookies(from: cookies).map(\.name))
        return !matchingNames.intersection(authCookieNames).isEmpty
    }

    public static func credentials(from cookies: [HTTPCookie], capturedAt: Date = Date()) -> YouTubeCredentials? {
        let header = cookieHeader(from: cookies)
        guard !header.isEmpty, hasRequiredAuthCookies(cookies) else { return nil }
        return YouTubeCredentials(cookieHeader: header, capturedAt: capturedAt)
    }

    public static func cookieHeader(from cookies: [HTTPCookie]) -> String {
        authCookies(from: cookies)
            .sorted { lhs, rhs in
                lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
            }
            .map { "\($0.name)=\($0.value)" }
            .joined(separator: "; ")
    }

    public static func redactedCookieHeader(_ header: String) -> String {
        header
            .split(separator: ";")
            .compactMap { part -> String? in
                let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                guard pair.count == 2 else { return nil }
                let name = pair[0].trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return nil }
                return "\(name)=..."
            }
            .joined(separator: "; ")
    }

    private static func authCookies(from cookies: [HTTPCookie]) -> [HTTPCookie] {
        cookies.filter { cookie in
            let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
            guard includedDomains.contains(where: { domain == $0 || domain.hasSuffix("." + $0) }) else {
                return false
            }
            return cookie.expiresDate.map { $0 > Date() } ?? true
        }
    }
}
