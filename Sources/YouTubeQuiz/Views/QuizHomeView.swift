import SwiftUI
import YouTubeQuizCore

struct QuizHomeView: View {
    @ObservedObject var viewModel: YouTubeConnectionViewModel

    var body: some View {
        List {
            Section("Available Quizzes") {
                if viewModel.isLoadingQuizzes {
                    ProgressView()
                } else if viewModel.quizzes.isEmpty {
                    ContentUnavailableView(
                        "No quizzes yet",
                        systemImage: "questionmark.circle",
                        description: Text("New quizzes will appear here after the server generates them from your YouTube history.")
                    )
                } else {
                    ForEach(viewModel.quizzes) { quiz in
                        NavigationLink {
                            QuizDetailView(viewModel: viewModel, quizId: quiz.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(quiz.videoTitle)
                                    .font(.headline)
                                Text("Question \(quiz.currentQuestionIndex + 1) of \(quiz.questionCount) · Score \(quiz.score, specifier: "%.1f")")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            Section("History") {
                if viewModel.quizHistory.isEmpty {
                    Text("Completed quizzes will appear here.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(viewModel.quizHistory) { quiz in
                        NavigationLink {
                            QuizDetailView(viewModel: viewModel, quizId: quiz.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(quiz.videoTitle)
                                    .font(.headline)
                                Text("Final score \(quiz.score, specifier: "%.1f") / \(quiz.questionCount)")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            if let message = viewModel.message {
                Section {
                    Text(message)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Quizzes")
        .toolbar {
            ToolbarItem(placement: signOutToolbarPlacement) {
                NavigationLink {
                    SettingsView(viewModel: viewModel)
                } label: {
                    Image(systemName: "gearshape")
                }
            }
        }
        .refreshable {
            await viewModel.loadQuizzes()
        }
        .task {
            await viewModel.loadQuizzes()
        }
    }

    private var signOutToolbarPlacement: ToolbarItemPlacement {
        #if os(iOS)
            .topBarTrailing
        #else
            .automatic
        #endif
    }
}
