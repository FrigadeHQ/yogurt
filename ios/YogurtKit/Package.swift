// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "YogurtKit",
    platforms: [.iOS(.v26), .macOS(.v15)],
    products: [.library(name: "YogurtKit", targets: ["YogurtKit"])],
    dependencies: [
        // libsodium 1.0.22 with ristretto255, prebuilt as an xcframework
        .package(url: "https://github.com/jedisct1/swift-sodium.git", exact: "0.11.0"),
    ],
    targets: [
        .target(name: "YogurtKit", dependencies: [.product(name: "Clibsodium", package: "swift-sodium")]),
        .testTarget(name: "YogurtKitTests", dependencies: ["YogurtKit"]),
    ]
)
