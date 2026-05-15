import SwiftUI
import YouTubeQuizCore

struct ContentView: View {
    @StateObject private var viewModel = YouTubeConnectionViewModel()

    var body: some View {
        NavigationStack {
            YouTubeConnectionView(viewModel: viewModel)
        }
    }
}
