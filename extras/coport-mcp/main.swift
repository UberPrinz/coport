import Foundation
import Darwin

// MCP framing, initialization and tools belong to the App. --tabby remains accepted.
signal(SIGPIPE, SIG_IGN)
func writeAll(_ fd: Int32, _ bytes: UnsafeRawPointer, _ count: Int) -> Bool {
    var offset = 0
    while offset < count {
        let n = Darwin.write(fd, bytes.advanced(by: offset), count-offset)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { return false }
        offset += n
    }
    return true
}
let environment = ProcessInfo.processInfo.environment
var connection = try? UnixSocket.connect()
if connection == nil && (environment["COPORT_TEST_SOCKET"] == nil || environment["COPORT_TEST_AUTOSTART_APP"] != nil) {
    let launcher = Process()
    if let app = environment["COPORT_TEST_AUTOSTART_APP"],
       let socket = environment["COPORT_TEST_SOCKET"] {
        launcher.executableURL = URL(fileURLWithPath: app).appendingPathComponent("Contents/MacOS/Coport")
        let data = URL(fileURLWithPath: socket).deletingLastPathComponent().path
        launcher.arguments = ["--coport-background", "--user-data-dir=\(data)", "--remote-debugging-port=0"]
    } else {
        launcher.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        launcher.arguments = ["-g", "-j", "-b", "local.coport.app", "--args", "--coport-background"]
    }
    launcher.standardOutput = FileHandle.standardError
    try? launcher.run()
    let deadline = ProcessInfo.processInfo.systemUptime+5
    repeat {
        usleep(200_000)
        connection = try? UnixSocket.connect()
    } while connection == nil && ProcessInfo.processInfo.systemUptime < deadline
}
guard let fd = connection else {
    FileHandle.standardError.write(Data("Coport not running\n".utf8)); exit(1)
}
DispatchQueue.global().async {
    var bytes = [UInt8](repeating: 0, count: 65536)
    while true {
        let n = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { shutdown(fd, SHUT_WR); return }
        if !writeAll(fd, &bytes, n) { shutdown(fd, SHUT_RDWR); return }
    }
}
var bytes = [UInt8](repeating: 0, count: 65536)
while true {
    let n = Darwin.read(fd, &bytes, bytes.count)
    if n < 0 && errno == EINTR { continue }
    if n <= 0 { break }
    if !writeAll(STDOUT_FILENO, &bytes, n) { Darwin.close(fd); exit(1) }
}
Darwin.close(fd)
