import Foundation

public enum ServerConfig {
    public static var baseURLString: String {
        Bundle.main.object(forInfoDictionaryKey: "QuizServerBaseURL") as? String ?? "https://youtube-quiz-production.up.railway.app"
    }
}
