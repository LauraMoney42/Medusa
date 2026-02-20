import Foundation

// MARK: - Errors

enum ServerError: LocalizedError {
    case nodeNotFound
    case npmNotFound
    case envFileNotFound(String)
    case startupTimeout
    case serverCrashed(String)
    case portInUse(Int)
    case buildFailed(String)

    var errorDescription: String? {
        switch self {
        case .nodeNotFound:
            return "Node.js not found.\nInstall via Homebrew: brew install node"
        case .npmNotFound:
            return "npm not found.\nInstall Node.js via Homebrew: brew install node"
        case .envFileNotFound(let path):
            return "Configuration file not found:\n\(path)\nCreate a .env file at the project root."
        case .startupTimeout:
            return "Server did not start within 30 seconds.\nCheck server logs for errors."
        case .serverCrashed(let msg):
            return "Server crashed:\n\(msg)"
        case .portInUse(let port):
            return "Port \(port) is already in use.\nStop the other process or change PORT in .env"
        case .buildFailed(let msg):
            return "Build failed:\n\(msg)"
        }
    }
}

// MARK: - ServerManager

class ServerManager {
    let projectRoot: String
    let serverDir: String
    let clientDir: String
    let envPath: String

    private var process: Process?
    private var stderrPipe: Pipe?
    private(set) var port: Int = 3456
    private(set) var host: String = "0.0.0.0"
    private(set) var authToken: String = ""

    /// Called on the main thread with status messages for the loading screen.
    var onStatus: ((String) -> Void)?

    init(projectRoot: String, serverDir: String, envPath: String) {
        self.projectRoot = projectRoot
        self.serverDir = serverDir
        self.clientDir = (projectRoot as NSString).appendingPathComponent("client")
        self.envPath = envPath
    }

    // MARK: - .env Parsing

    private func parseEnv() throws -> [String: String] {
        guard FileManager.default.fileExists(atPath: envPath) else {
            throw ServerError.envFileNotFound(envPath)
        }

        let content = try String(contentsOfFile: envPath, encoding: .utf8)
        var env: [String: String] = [:]

        for line in content.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }

            guard let eqIdx = trimmed.firstIndex(of: "=") else { continue }
            let key = String(trimmed[trimmed.startIndex..<eqIdx])
                .trimmingCharacters(in: .whitespaces)
            var value = String(trimmed[trimmed.index(after: eqIdx)...])
                .trimmingCharacters(in: .whitespaces)

            // Strip surrounding quotes
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
               (value.hasPrefix("'") && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            }

            env[key] = value
        }

        return env
    }

    // MARK: - Binary Discovery

    /// Find the Node.js binary on this system.
    private func findNode() -> String? {
        return findBinary("node")
    }

    /// Find npm on this system.
    private func findNpm() -> String? {
        return findBinary("npm")
    }

    private func findBinary(_ name: String) -> String? {
        let candidates = [
            "/opt/homebrew/bin/\(name)",   // Apple Silicon Homebrew
            "/usr/local/bin/\(name)",      // Intel Homebrew
        ]

        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }

        // Fallback: ask the shell
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["which", name]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let path = path, !path.isEmpty,
               FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        } catch {}

        return nil
    }

    // MARK: - Port Check

    private func isPortInUse(_ port: Int) -> Bool {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        defer { close(sock) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                connect(sock, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    // MARK: - Kill Port Holders

    /// Use lsof to find and SIGTERM any processes listening on the given port.
    private func killPortHolders(_ port: Int) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        proc.arguments = ["-i", ":\(port)", "-t"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            proc.waitUntilExit()
        } catch { return }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return }

        let pids = output.split(separator: "\n").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
        for pid in pids {
            kill(pid, SIGTERM)
        }
    }

    // MARK: - Run Shell Command

    /// Run a command synchronously, returning (exitCode, stdout+stderr).
    @discardableResult
    private func runCommand(_ executable: String, args: [String], cwd: String) throws -> (Int32, String) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: executable)
        proc.arguments = args
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)

        // Ensure Homebrew binaries are on PATH for child processes (e.g. npx, tsc)
        var env = ProcessInfo.processInfo.environment
        let currentPath = env["PATH"] ?? "/usr/bin:/bin"
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(currentPath)"
        proc.environment = env

        let outPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = outPipe

        try proc.run()
        proc.waitUntilExit()

        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""

        return (proc.terminationStatus, output)
    }

    // MARK: - Auto-Build

    /// Check if the project is built, and build it if not.
    /// Runs synchronously on a background thread — call from DispatchQueue.global().
    private func ensureBuilt(npmPath: String) throws {
        let fm = FileManager.default

        // 1. Install client dependencies if needed
        let clientModules = (clientDir as NSString).appendingPathComponent("node_modules")
        if !fm.fileExists(atPath: clientModules) {
            updateStatus("Installing client dependencies...")
            let (code, output) = try runCommand(npmPath, args: ["install"], cwd: clientDir)
            if code != 0 {
                throw ServerError.buildFailed("npm install (client) failed:\n\(output.suffix(500))")
            }
        }

        // 2. Install server dependencies if needed
        let serverModules = (serverDir as NSString).appendingPathComponent("node_modules")
        if !fm.fileExists(atPath: serverModules) {
            updateStatus("Installing server dependencies...")
            let (code, output) = try runCommand(npmPath, args: ["install"], cwd: serverDir)
            if code != 0 {
                throw ServerError.buildFailed("npm install (server) failed:\n\(output.suffix(500))")
            }
        }

        // 3. Check if server is built
        let serverEntry = (serverDir as NSString).appendingPathComponent("dist/index.js")
        let clientIndex = (clientDir as NSString).appendingPathComponent("dist/index.html")
        let publicIndex = (serverDir as NSString).appendingPathComponent("dist/public/index.html")

        let needsClientBuild = !fm.fileExists(atPath: clientIndex)
        let needsServerBuild = !fm.fileExists(atPath: serverEntry)
        let needsPublicCopy = !fm.fileExists(atPath: publicIndex)

        // 4. Build client if needed
        if needsClientBuild || needsPublicCopy {
            updateStatus("Building client...")
            let (code, output) = try runCommand(npmPath, args: ["run", "build"], cwd: clientDir)
            if code != 0 {
                throw ServerError.buildFailed("Client build failed:\n\(output.suffix(500))")
            }
        }

        // 5. Copy client dist to server/dist/public if needed
        let clientDist = (clientDir as NSString).appendingPathComponent("dist")
        let serverPublic = (serverDir as NSString).appendingPathComponent("dist/public")
        if needsClientBuild || needsPublicCopy {
            updateStatus("Copying client to server...")
            try? fm.createDirectory(atPath: serverPublic, withIntermediateDirectories: true)
            // Remove old contents
            if let items = try? fm.contentsOfDirectory(atPath: serverPublic) {
                for item in items {
                    try? fm.removeItem(atPath: (serverPublic as NSString).appendingPathComponent(item))
                }
            }
            // Copy new contents
            if let items = try? fm.contentsOfDirectory(atPath: clientDist) {
                for item in items {
                    let src = (clientDist as NSString).appendingPathComponent(item)
                    let dst = (serverPublic as NSString).appendingPathComponent(item)
                    try fm.copyItem(atPath: src, toPath: dst)
                }
            }
        }

        // 6. Build server if needed
        if needsServerBuild {
            updateStatus("Building server...")
            let (code, output) = try runCommand(npmPath, args: ["run", "build"], cwd: serverDir)
            if code != 0 {
                throw ServerError.buildFailed("Server build failed:\n\(output.suffix(500))")
            }
        }

        // Final validation
        guard fm.fileExists(atPath: serverEntry) else {
            throw ServerError.buildFailed("Build completed but server/dist/index.js not found.")
        }
    }

    /// Send a status update to the main thread.
    private func updateStatus(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            self?.onStatus?(message)
        }
    }

    // MARK: - Start

    /// Start the Node.js server. Calls completion on main thread when ready or on error.
    func start(completion: @escaping (Result<Int, Error>) -> Void) {
        // 1. Parse .env
        let env: [String: String]
        do {
            env = try parseEnv()
        } catch {
            completion(.failure(error))
            return
        }

        port = Int(env["PORT"] ?? "3456") ?? 3456
        host = env["HOST"] ?? "0.0.0.0"
        authToken = env["AUTH_TOKEN"] ?? ""

        // 2. Free port if a stale process is holding it
        if isPortInUse(port) {
            killPortHolders(port)
            // Brief wait for processes to exit
            Thread.sleep(forTimeInterval: 0.5)
            if isPortInUse(port) {
                completion(.failure(ServerError.portInUse(port)))
                return
            }
        }

        // 3. Find node and npm
        guard let nodePath = findNode() else {
            completion(.failure(ServerError.nodeNotFound))
            return
        }

        guard let npmPath = findNpm() else {
            completion(.failure(ServerError.npmNotFound))
            return
        }

        // 4. Auto-build on a background thread (npm install + build can be slow)
        updateStatus("Checking build...")
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            do {
                try self.ensureBuilt(npmPath: npmPath)
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
                return
            }

            // 5. Back on main thread: spawn the server
            DispatchQueue.main.async { [self] in
                self.updateStatus("Starting server...")
                self.spawnServer(nodePath: nodePath, completion: completion)
            }
        }
    }

    // MARK: - Spawn Server

    private func spawnServer(nodePath: String, completion: @escaping (Result<Int, Error>) -> Void) {
        let entryPoint = (serverDir as NSString).appendingPathComponent("dist/index.js")

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [entryPoint]
        proc.currentDirectoryURL = URL(fileURLWithPath: serverDir)

        // Forward env vars
        var procEnv = ProcessInfo.processInfo.environment
        procEnv["PORT"] = String(port)
        procEnv["HOST"] = host
        if !authToken.isEmpty {
            procEnv["AUTH_TOKEN"] = authToken
        }
        proc.environment = procEnv

        // Capture stderr for error reporting
        let errPipe = Pipe()
        proc.standardError = errPipe
        proc.standardOutput = FileHandle.nullDevice
        self.stderrPipe = errPipe

        // Track if completion was already called
        var completed = false
        let completionOnce: (Result<Int, Error>) -> Void = { result in
            guard !completed else { return }
            completed = true
            DispatchQueue.main.async { completion(result) }
        }

        proc.terminationHandler = { [weak self] p in
            guard self?.process != nil else { return }
            let data = errPipe.fileHandleForReading.availableData
            let msg = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? "exit code \(p.terminationStatus)"
            completionOnce(.failure(ServerError.serverCrashed(msg)))
        }

        do {
            try proc.run()
        } catch {
            completionOnce(.failure(ServerError.serverCrashed(error.localizedDescription)))
            return
        }
        self.process = proc

        // Poll health endpoint
        pollHealth(timeout: 30.0, completion: completionOnce)
    }

    // MARK: - Health Polling

    private func pollHealth(timeout: TimeInterval, completion: @escaping (Result<Int, Error>) -> Void) {
        let startTime = Date()
        let url = URL(string: "http://localhost:\(port)/api/health")!

        func poll() {
            guard let proc = process, proc.isRunning else { return }

            if Date().timeIntervalSince(startTime) > timeout {
                completion(.failure(ServerError.startupTimeout))
                return
            }

            let task = URLSession.shared.dataTask(with: url) { _, response, _ in
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    completion(.success(self.port))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        poll()
                    }
                }
            }
            task.resume()
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            poll()
        }
    }

    // MARK: - Stop

    func stop() {
        guard let proc = process, proc.isRunning else { return }
        let ref = proc
        process = nil

        ref.terminate()

        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(3.0)
            while ref.isRunning && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.1)
            }
            if ref.isRunning {
                ref.interrupt()
            }
            ref.waitUntilExit()
        }
    }
}
