import Foundation

public enum ServerConfig {
    public static var baseURLString: String {
        Bundle.main.object(forInfoDictionaryKey: "QuizServerBaseURL") as? String ?? "http://127.0.0.1:3000"
    }
}
