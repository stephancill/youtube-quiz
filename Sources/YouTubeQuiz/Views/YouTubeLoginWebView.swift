import SwiftUI
import WebKit
import YouTubeQuizCore

private let youtubeLoginUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

struct YouTubeLoginWebView: View {
    @Environment(\.dismiss) private var dismiss

    var onLoginSuccess: (YouTubeCredentials) -> Void

    var body: some View {
        NavigationStack {
            YouTubeLoginWKWebView(
                url: URL(string: "https://www.youtube.com/feed/history")!,
                onCookiesFound: { cookies in
                    guard let credentials = YouTubeCookieHeaderBuilder.credentials(from: cookies) else { return }
                    onLoginSuccess(credentials)
                    dismiss()
                }
            )
            .ignoresSafeArea()
            .navigationTitle("Log in to YouTube")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
        }
    }
}

#if os(iOS)
    private struct YouTubeLoginWKWebView: UIViewRepresentable {
        let url: URL
        let onCookiesFound: ([HTTPCookie]) -> Void

        @MainActor
        func makeUIView(context: Context) -> WKWebView {
            makeWebView(context: context)
        }

        func updateUIView(_: WKWebView, context _: Context) {}

        @MainActor
        func makeCoordinator() -> Coordinator {
            Coordinator(onCookiesFound: onCookiesFound)
        }
    }
#else
    private struct YouTubeLoginWKWebView: NSViewRepresentable {
        let url: URL
        let onCookiesFound: ([HTTPCookie]) -> Void

        @MainActor
        func makeNSView(context: Context) -> WKWebView {
            makeWebView(context: context)
        }

        func updateNSView(_: WKWebView, context _: Context) {}

        @MainActor
        func makeCoordinator() -> Coordinator {
            Coordinator(onCookiesFound: onCookiesFound)
        }
    }
#endif

private extension YouTubeLoginWKWebView {
    @MainActor
    func makeWebView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.customUserAgent = youtubeLoginUserAgent
        webView.load(URLRequest(url: url))
        return webView
    }
}

@MainActor
private final class Coordinator: NSObject, WKNavigationDelegate {
    let onCookiesFound: ([HTTPCookie]) -> Void
    private var hasNotified = false

    init(onCookiesFound: @escaping ([HTTPCookie]) -> Void) {
        self.onCookiesFound = onCookiesFound
    }

    nonisolated func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
        Task { @MainActor in
            guard !hasNotified else { return }
            checkForAuthCookies(webView: webView)
        }
    }

    private func checkForAuthCookies(webView: WKWebView) {
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
            guard YouTubeCookieHeaderBuilder.hasRequiredAuthCookies(cookies) else { return }
            self.hasNotified = true
            DispatchQueue.main.async {
                self.onCookiesFound(cookies)
            }
        }
    }
}
