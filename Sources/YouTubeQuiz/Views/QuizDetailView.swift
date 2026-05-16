import SwiftUI
import YouTubeQuizCore

struct QuizDetailView: View {
    @ObservedObject var viewModel: YouTubeConnectionViewModel
    let quizId: Int

    @State private var quiz: AppQuizDetail?
    @State private var answer = ""
    @State private var lastResult: AppAnswerResult?
    @State private var message: String?
    @State private var isLoading = false
    @State private var isSubmitting = false

    var body: some View {
        Form {
            if isLoading {
                Section {
                    ProgressView()
                }
            } else if let quiz {
                Section("Progress") {
                    Text(quiz.videoTitle)
                        .font(.headline)
                    Text("Score \(quiz.score, specifier: "%.1f") / \(quiz.questionCount)")
                        .foregroundStyle(.secondary)
                }

                if quiz.status == "completed" || quiz.currentQuestion == nil {
                    Section {
                        ContentUnavailableView(
                            "Quiz complete",
                            systemImage: "checkmark.circle",
                            description: Text("Final score: \(quiz.score, specifier: "%.1f") / \(quiz.questionCount)")
                        )
                    }

                    Section("Questions and Answers") {
                        ForEach(Array(quiz.questions.enumerated()), id: \.element.id) { index, question in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text("Question \(index + 1)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                    CorrectnessBadge(result: question.result)
                                }
                                Text(question.prompt)
                                Text("Expected answer: \(question.correctAnswer)")
                                    .foregroundStyle(.secondary)
                                if let result = question.result {
                                    Text("Your answer: \(result.userAnswer)")
                                        .foregroundStyle(.secondary)
                                    Text(result.feedback)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Text("Source: \(question.sourceTimestamp)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                } else if let question = quiz.currentQuestion {
                    Section("Question \(quiz.currentQuestionIndex + 1) of \(quiz.questionCount)") {
                        Text(question.prompt)
                        if let hint = question.hint {
                            Text("Hint: \(hint)")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Section("Your Answer") {
                        TextField("Answer", text: $answer, axis: .vertical)
                            .lineLimit(3 ... 6)

                        Button {
                            Task { await submitAnswer() }
                        } label: {
                            if isSubmitting {
                                ProgressView()
                            } else {
                                Text("Submit Answer")
                            }
                        }
                        .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSubmitting)
                    }
                }
            }

            if let lastResult {
                Section("Last Answer") {
                    Text("Score: \(lastResult.grade.score, specifier: "%.1f")")
                    Text(lastResult.grade.feedback)
                        .foregroundStyle(.secondary)
                }
            }

            if let message {
                Section {
                    Text(message)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Quiz")
        .task {
            await loadQuiz()
        }
        .refreshable {
            await loadQuiz()
        }
    }

    private func loadQuiz() async {
        isLoading = true
        defer { isLoading = false }

        do {
            quiz = try await viewModel.quizDetail(quizId: quizId)
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    private func submitAnswer() async {
        let submittedAnswer = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !submittedAnswer.isEmpty else { return }

        isSubmitting = true
        defer { isSubmitting = false }

        do {
            let result = try await viewModel.submitAnswer(quizId: quizId, answer: submittedAnswer)
            lastResult = result
            quiz = result.quiz
            answer = ""
            message = result.completed ? "Quiz complete." : nil
        } catch {
            message = error.localizedDescription
        }
    }
}

private struct CorrectnessBadge: View {
    let result: AppQuizQuestionResult?

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: Capsule())
    }

    private var label: String {
        guard let result else { return "Not tracked" }
        if result.score >= 1 { return "Correct" }
        if result.score > 0 { return "Partially correct" }
        return "Incorrect"
    }

    private var color: Color {
        guard let result else { return .secondary }
        if result.score >= 1 { return .green }
        if result.score > 0 { return .orange }
        return .red
    }
}
