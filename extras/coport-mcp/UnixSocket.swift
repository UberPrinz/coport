import Foundation
import Darwin

public enum UnixSocket {
    public static var path: String {
        if let override = ProcessInfo.processInfo.environment["COPORT_TEST_SOCKET"] { return override }
        return defaultPath
    }
    public static var defaultPath: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Coport/mcp.sock").path
    }
    public static func address(_ path: String) throws -> sockaddr_un {
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw POSIXError(.ENAMETOOLONG)
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { dest in dest.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
        return address
    }
    public static func connect(path: String = path) throws -> Int32 {
        var address = try address(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard result == 0 else { let error = errno; Darwin.close(fd); throw POSIXError(POSIXErrorCode(rawValue: error) ?? .EIO) }
        return fd
    }
}
