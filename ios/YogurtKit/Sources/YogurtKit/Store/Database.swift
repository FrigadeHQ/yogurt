import Foundation
import SQLite3

/// A value bound into, or read out of, one SQL column.
enum SQLValue: Equatable {
    case null, int(Int64), real(Double), text(String)

    static func of(_ s: String?) -> SQLValue { s.map { .text($0) } ?? .null }
    static func of(_ i: Int64?) -> SQLValue { i.map { .int($0) } ?? .null }
    static func of(_ i: Int) -> SQLValue { .int(Int64(i)) }

    var string: String? { if case .text(let s) = self { s } else { nil } }
    var int: Int64? {
        switch self {
        case .int(let i): i
        case .real(let d): clampedInt64(d)
        default: nil
        }
    }
}

/// Int64(Double) traps on NaN or out of range; a malformed record must not crash the app.
func clampedInt64(_ d: Double) -> Int64 {
    guard d.isFinite else { return 0 }
    return d >= 9.2e18 ? .max : d <= -9.2e18 ? .min : Int64(d.rounded())
}

struct DatabaseError: Error, CustomStringConvertible {
    let code: Int32
    let message: String
    var description: String { "SQLite \(code): \(message)" }
}

/// The smallest wrapper over the system SQLite that the store needs. Not thread-safe: the Store that owns it keeps it
/// on one actor. Values are always bound, never spliced into SQL.
final class Database {
    private var handle: OpaquePointer?
    private let url: URL
    /// tests only: makes the next rollback fail, as an I/O error or a locked device would
    var rollbackHook: (() throws -> Void)?

    init(url: URL) throws {
        self.url = url
        try open()
    }

    private func open() throws {
        var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        #if os(iOS)
        // notes and transcripts are only readable while the phone is unlocked; the flag covers the journal files too
        flags |= SQLITE_OPEN_FILEPROTECTION_COMPLETE
        #endif
        var h: OpaquePointer?
        let rc = sqlite3_open_v2(url.path, &h, flags, nil)
        guard rc == SQLITE_OK else {
            let message = h.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close_v2(h)
            throw DatabaseError(code: rc, message: message)
        }
        handle = h
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        #endif
        try run("PRAGMA journal_mode = WAL")
    }

    /// Closing drops whatever transaction is still open, so nothing later lands inside it unsaved. If opening again
    /// fails (the phone locked), the next call tries once more.
    private func reopen() {
        sqlite3_close_v2(handle)
        handle = nil
        try? open()
    }

    deinit { sqlite3_close_v2(handle) }

    func run(_ sql: String, _ args: [SQLValue] = []) throws {
        _ = try query(sql, args)
    }

    /// Every row of the result, each as its columns in order.
    @discardableResult
    func query(_ sql: String, _ args: [SQLValue] = []) throws -> [[SQLValue]] {
        if handle == nil { try open() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else { throw error() }
        defer { sqlite3_finalize(stmt) }
        // SQLite copies bound text before the call returns
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, arg) in args.enumerated() {
            let at = Int32(i + 1)
            let rc: Int32 = switch arg {
            case .null: sqlite3_bind_null(stmt, at)
            case .int(let v): sqlite3_bind_int64(stmt, at, v)
            case .real(let v): sqlite3_bind_double(stmt, at, v)
            // by byte count, so a NUL inside the text doesn't cut it short
            case .text(let v): sqlite3_bind_text(stmt, at, v, Int32(v.utf8.count), transient)
            }
            guard rc == SQLITE_OK else { throw error() }
        }
        var rows: [[SQLValue]] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw error() }
            rows.append((0..<sqlite3_column_count(stmt)).map { col in
                switch sqlite3_column_type(stmt, col) {
                case SQLITE_INTEGER: .int(sqlite3_column_int64(stmt, col))
                case SQLITE_FLOAT: .real(sqlite3_column_double(stmt, col))
                case SQLITE_NULL: .null
                default: .text(text(stmt, col))
                }
            })
        }
        return rows
    }

    /// Rows changed by the last INSERT, UPDATE or DELETE.
    var changes: Int { Int(sqlite3_changes(handle)) }

    /// All or nothing. Savepoints, so a transaction inside another one works.
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try run("SAVEPOINT tx")
        do {
            let result = try body()
            try run("RELEASE tx")
            return result
        } catch {
            do {
                try rollbackHook?()
                try run("ROLLBACK TO tx")
                try run("RELEASE tx")
            } catch {
                reopen()
            }
            throw error
        }
    }

    private func text(_ stmt: OpaquePointer?, _ col: Int32) -> String {
        guard let p = sqlite3_column_text(stmt, col) else { return "" }
        return String(decoding: UnsafeBufferPointer(start: p, count: Int(sqlite3_column_bytes(stmt, col))), as: UTF8.self)
    }

    private func error() -> DatabaseError {
        DatabaseError(code: sqlite3_errcode(handle), message: String(cString: sqlite3_errmsg(handle)))
    }
}
