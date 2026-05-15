// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "YouTubeQuiz",
    platforms: [
        .iOS(.v18),
        .macOS(.v14),
    ],
    products: [
        // An xtool project should contain exactly one library product,
        // representing the main app.
        .library(
            name: "YouTubeQuiz",
            targets: ["YouTubeQuiz"]
        ),
    ],
    targets: [
        .target(
            name: "YouTubeQuiz",
            dependencies: ["YouTubeQuizCore"]
        ),
        .target(
            name: "YouTubeQuizCore"
        ),
        .testTarget(
            name: "YouTubeQuizTests",
            dependencies: ["YouTubeQuizCore"]
        ),
    ]
)
