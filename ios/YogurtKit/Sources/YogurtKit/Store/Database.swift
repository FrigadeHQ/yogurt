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
        case .real(let d): Int64(d)
        default: nil
        }
    }
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

    init(url: URL) throws {
        var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        #if os(iOS)
        // notes and transcripts are only readable while the phone is unlocked; the flag covers the journal files too
        flags |= SQLITE_OPEN_FILEPROTECTION_COMPLETE
        #endif
        let rc = sqlite3_open_v2(url.path, &handle, flags, nil)
        guard rc == SQLITE_OK else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close_v2(handle)
            handle = nil
            throw DatabaseError(code: rc, message: message)
        }
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        #endif
        try run("PRAGMA journal_mode = WAL")
        try run("PRAGMA foreign_keys = ON")
    }

    deinit { sqlite3_close_v2(handle) }

    func run(_ sql: String, _ args: [SQLValue] = []) throws {
        _ = try query(sql, args)
    }

    /// Every row of the result, each as its columns in order.
    @discardableResult
    func query(_ sql: String, _ args: [SQLValue] = []) throws -> [[SQLValue]] {
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
            case .text(let v): sqlite3_bind_text(stmt, at, v, -1, transient)
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
                default: .text(String(cString: sqlite3_column_text(stmt, col)))
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
            try? run("ROLLBACK TO tx")
            try? run("RELEASE tx")
            throw error
        }
    }

    private func error() -> DatabaseError {
        DatabaseError(code: sqlite3_errcode(handle), message: String(cString: sqlite3_errmsg(handle)))
    }
}
