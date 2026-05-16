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
                                QuestionBreakdown(quiz: quiz)
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
                                QuestionBreakdown(quiz: quiz)
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

private struct QuestionBreakdown: View {
    let quiz: AvailableQuiz

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0 ..< quiz.questionCount, id: \.self) { index in
                QuestionBreakdownMark(score: score(at: index))
            }
        }
        .font(.subheadline.weight(.semibold))
        .accessibilityLabel(accessibilityLabel)
    }

    private func score(at index: Int) -> Double? {
        guard index < quiz.answerScores.count else { return nil }
        return quiz.answerScores[index]
    }

    private var accessibilityLabel: String {
        let labels = (0 ..< quiz.questionCount).map { index in
            guard let score = score(at: index) else { return "unanswered" }
            if score >= 1 { return "correct" }
            if score > 0 { return "partially correct" }
            return "incorrect"
        }
        return labels.joined(separator: ", ")
    }
}

private struct QuestionBreakdownMark: View {
    let score: Double?

    var body: some View {
        if let score {
            Image(systemName: score > 0 ? "checkmark" : "xmark")
                .foregroundStyle(color(for: score))
        } else {
            Text("-")
                .foregroundStyle(.secondary)
        }
    }

    private func color(for score: Double) -> Color {
        if score >= 1 { return .green }
        if score > 0 { return .blue }
        return .red
    }
}
