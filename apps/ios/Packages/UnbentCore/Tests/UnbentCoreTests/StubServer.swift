import Foundation
import XCTest
@testable import UnbentCore

/// A server that answers from a queue and keeps what it was asked, standing where
/// `MockWebServer` stands in the Kotlin tests.
///
/// A `URLProtocol` rather than a socket: it sees the request exactly as `URLSession` would
/// send it, and nothing leaves the process. Static state because `URLSession` makes the
/// protocol's instances itself; the tests in a class run one at a time, and each one
/// starts by calling `reset`.
final class StubServer: URLProtocol {
    struct Answer {
        var status = 200
        var headers: [String: String] = [:]
        var body = "{}"
    }

    struct Asked {
        let method: String
        let path: String
        let headers: [String: String]
        let body: String
    }

    private static let lock = NSLock()
    private static var answers: [Answer] = []
    private static var asked: [Asked] = []

    static let origin = "http://stub.test"

    static func reset() {
        lock.withLock {
            answers = []
            asked = []
        }
    }

    static func enqueue(_ answer: Answer) {
        lock.withLock { answers.append(answer) }
    }

    static func takeRequest(file: StaticString = #filePath, line: UInt = #line) throws -> Asked {
        try lock.withLock {
            try XCTUnwrap(asked.isEmpty ? nil : asked.removeFirst(), "no request was made", file: file, line: line)
        }
    }

    /// A session whose every request comes here, configured otherwise as the app's is.
    static func session() -> URLSession {
        let config = UnbentApi.configuration()
        config.protocolClasses = [StubServer.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        // A body given to URLSession reaches a protocol as a stream, never as `httpBody`.
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                body.append(buffer, count: read)
            }
            stream.close()
        }
        let url = request.url!
        let path = url.path + (url.query.map { "?\($0)" } ?? "")
        let answer: Answer? = Self.lock.withLock {
            Self.asked.append(Asked(
                method: request.httpMethod ?? "GET",
                path: path,
                headers: request.allHTTPHeaderFields ?? [:],
                body: String(decoding: body, as: UTF8.self)
            ))
            return Self.answers.isEmpty ? nil : Self.answers.removeFirst()
        }
        guard let answer else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: answer.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

