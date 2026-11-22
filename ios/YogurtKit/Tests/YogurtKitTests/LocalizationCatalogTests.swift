import Foundation
import Testing

/// The app's String Catalogs (ios/Yogurt/*.xcstrings), read as the JSON they are: every text in every language
/// desktop Yogurt ships, with the same blanks as the English.
@Suite struct LocalizationCatalogTests {
    static let languages = ["en", "ar", "bn", "cs", "da", "de", "el", "es", "fi", "fil", "fr", "he", "hi", "hu", "id", "it", "ja",
                            "ko", "ms", "nb", "nl", "pl", "pt-BR", "ro", "ru", "sv", "th", "tr", "uk", "vi", "zh-Hans", "zh-Hant"]
    static let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../..").standardizedFileURL

    struct Entry { var units: [String: [String]] }

    /// key → language → its values (one, or one per plural form)
    static func catalog(_ name: String) throws -> [String: [String: [String]]] {
        let data = try Data(contentsOf: ios.appendingPathComponent("Yogurt/\(name).xcstrings"))
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let strings = try #require(json["strings"] as? [String: [String: Any]])
        var out: [String: [String: [String]]] = [:]
        for (key, entry) in strings {
            let locs = entry["localizations"] as? [String: [String: Any]] ?? [:]
            out[key] = locs.mapValues { loc in
                if let unit = loc["stringUnit"] as? [String: Any], let v = unit["value"] as? String { return [v] }
                let plural = (loc["variations"] as? [String: Any])?["plural"] as? [String: [String: Any]] ?? [:]
                // without "other" a count with no form of its own would show nothing
                guard plural["other"] != nil else { return [] }
                return plural.values.compactMap { ($0["stringUnit"] as? [String: Any])?["value"] as? String }
            }
        }
        return out
    }

    /// "%@", "%lld", "%2$@" → their types in order of the arguments, so a translation may reorder them.
    static func specifiers(_ s: String) -> [String] {
        let regex = try! NSRegularExpression(pattern: #"%(?:(\d+)\$)?(lld|@|d)"#)
        let found = regex.matches(in: s, range: NSRange(s.startIndex..., in: s)).enumerated().map { i, m -> (Int, String) in
            let pos = Range(m.range(at: 1), in: s).flatMap { Int(s[$0]) } ?? i + 1
            return (pos, String(s[Range(m.range(at: 2), in: s)!]))
        }
        return found.sorted { $0.0 < $1.0 }.map(\.1)
    }

    @Test func everyTextIsInEveryLanguage() throws {
        for name in ["Localizable", "InfoPlist"] {
            for (key, locs) in try Self.catalog(name) {
                for lang in Self.languages {
                    let values = locs[lang] ?? []
                    #expect(!values.isEmpty && values.allSatisfy { !$0.trimmingCharacters(in: .whitespaces).isEmpty },
                            "\(name): \(lang) has no text for “\(key)”")
                }
            }
        }
    }

    @Test func blanksMatchTheEnglish() throws {
        for (key, locs) in try Self.catalog("Localizable") {
            let english = Self.specifiers(key)
            for (lang, values) in locs {
                for v in values {
                    // a plural form may leave out its one number ("one minute")
                    let ok = Self.specifiers(v) == english || (values.count > 1 && english.count == 1 && Self.specifiers(v).isEmpty)
                    #expect(ok, "\(lang) “\(v)” has other blanks than “\(key)”")
                }
            }
        }
    }

    @Test func everyTextTheAppShowsIsInTheCatalog() throws {
        let keys = Set(try Self.catalog("Localizable").keys)
        var missing: [String] = []
        for folder in ["Yogurt", "YogurtKit/Sources"] {
            let files = FileManager.default.enumerator(at: Self.ios.appendingPathComponent(folder), includingPropertiesForKeys: nil)!
            for case let file as URL in files where file.pathExtension == "swift" {
                for key in Self.localizedKeys(try String(contentsOf: file, encoding: .utf8)) where !keys.contains(key) { missing.append(key) }
            }
        }
        #expect(missing.isEmpty, "not in Localizable.xcstrings: \(missing)")
    }

    @Test func theAppListsTheSameLanguages() throws {
        let yml = try String(contentsOf: Self.ios.appendingPathComponent("project.yml"), encoding: .utf8)
        let block = try #require(yml.components(separatedBy: "CFBundleLocalizations:").last)
        let listed = block.split(separator: "\n").prefix { $0.trimmingCharacters(in: .whitespaces).hasPrefix("- ") }
            .map { $0.trimmingCharacters(in: .whitespaces).dropFirst(2).trimmingCharacters(in: .whitespaces) }
        #expect(listed == Self.languages)
    }

    /// The keys of `String(localized: "…")` literals: an interpolated Int (n, total, more) is %lld, anything else %@.
    static func localizedKeys(_ source: String) -> [String] {
        var keys: [String] = []
        var rest = Substring(source)
        while let start = rest.range(of: #"String(localized: ""#) {
            var i = start.upperBound, key = ""
            while i < rest.endIndex, rest[i] != "\"" {
                if rest[i...].hasPrefix("\\(") {
                    var depth = 0, j = rest.index(i, offsetBy: 1)
                    let exprStart = rest.index(after: j)
                    repeat {
                        if rest[j] == "(" { depth += 1 } else if rest[j] == ")" { depth -= 1 }
                        j = rest.index(after: j)
                    } while depth > 0
                    let expr = rest[exprStart..<rest.index(before: j)]
                    key += ["n", "total", "more"].contains(String(expr)) ? "%lld" : "%@"
                    i = j
                } else if rest[i...].hasPrefix("\\\"") {
                    key += "\""; i = rest.index(i, offsetBy: 2)
                } else {
                    key.append(rest[i]); i = rest.index(after: i)
                }
            }
            keys.append(key)
            rest = rest[i...]
        }
        return keys
    }
}
