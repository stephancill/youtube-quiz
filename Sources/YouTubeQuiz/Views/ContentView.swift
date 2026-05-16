import SwiftUI
import YouTubeQuizCore

struct ContentView: View {
    @StateObject private var viewModel = YouTubeConnectionViewModel()
    @State private var navigationPath: [String] = []

    var body: some View {
        NavigationStack(path: $navigationPath) {
            Group {
                if viewModel.appSession == nil {
                    SignInView(viewModel: viewModel)
                } else if !viewModel.isYouTubeLinked {
                    YouTubeConnectionView(viewModel: viewModel)
                } else {
                    QuizHomeView(viewModel: viewModel)
                }
            }
        }
        .id(rootRoute)
        .onChange(of: rootRoute) { _, _ in
            navigationPath = []
        }
        .task {
            await viewModel.load()
        }
    }

    private var rootRoute: String {
        if viewModel.appSession == nil { return "signed-out" }
        if !viewModel.isYouTubeLinked { return "youtube" }
        return "home"
    }
}
