import Foundation
import Testing
@testable import YouTubeQuizCore

@Suite("YouTube cookie header builder")
struct YouTubeCookieHeaderBuilderTests {
    @Test("builds a header from YouTube cookies")
    func buildsCookieHeader() throws {
        let cookies = try [
            cookie(name: "SID", value: "sid", domain: ".youtube.com"),
            cookie(name: "VISITOR_INFO1_LIVE", value: "visitor", domain: ".youtube.com"),
            cookie(name: "SAPISID", value: "google", domain: ".google.com"),
            cookie(name: "ignored", value: "nope", domain: ".example.com"),
        ]

        let credentials = try #require(YouTubeCookieHeaderBuilder.credentials(from: cookies, capturedAt: Date(timeIntervalSince1970: 0)))

        #expect(credentials.cookieHeader.contains("SID=sid"))
        #expect(credentials.cookieHeader.contains("VISITOR_INFO1_LIVE=visitor"))
        #expect(!credentials.cookieHeader.contains("SAPISID=google"))
        #expect(!credentials.cookieHeader.contains("ignored=nope"))
    }

    @Test("redacts values")
    func redactsValues() {
        let redacted = YouTubeCookieHeaderBuilder.redactedCookieHeader("SID=abc; VISITOR_INFO1_LIVE=xyz")
        #expect(redacted == "SID=...; VISITOR_INFO1_LIVE=...")
    }

    private func cookie(name: String, value: String, domain: String) throws -> HTTPCookie {
        try #require(HTTPCookie(properties: [
            .name: name,
            .value: value,
            .domain: domain,
            .path: "/",
        ]))
    }
}
