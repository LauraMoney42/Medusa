import Cocoa
import WebKit
import ScreenCaptureKit

// Weak wrapper to break the retain cycle between WKUserContentController and the handler.
// WKUserContentController retains its script message handlers strongly; if WebViewController
// is both the handler and the WKWebView owner, you get a cycle that prevents dealloc.
private class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WebViewController?
    init(_ target: WebViewController) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}

class WebViewController: NSWindowController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var containerView: NSView!
    private var loadingView: NSView!
    private var loadingLabel: NSTextField!
    private var spinner: NSProgressIndicator!
    private let serverManager: ServerManager
    // SC5/SC6: Retained for the lifetime of a picker session.
    // AnyObject erases the @available(macOS 14.0, *) requirement at the property level.
    private var windowPickerController: AnyObject?
    private var regionPickerController: AnyObject?

    init(serverManager: ServerManager) {
        self.serverManager = serverManager

        // Create window
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Medusa"
        window.minSize = NSSize(width: 800, height: 600)
        window.center()
        window.setFrameAutosaveName("MedusaMain")

        super.init(window: window)

        setupViews()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    // MARK: - Setup

    private func setupViews() {
        guard let window = window else { return }

        // Container view as the window's contentView
        containerView = NSView(frame: window.contentLayoutRect)
        containerView.wantsLayer = true
        window.contentView = containerView

        // WKWebView configuration
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()

        // SC4: Register native screen capture message handler.
        // JS triggers capture via: window.webkit.messageHandlers.captureScreen.postMessage({})
        // Result is returned asynchronously as a 'medusaNativeCapture' CustomEvent on window.
        config.userContentController.add(WeakScriptMessageHandler(self), name: "captureScreen")

        webView = WKWebView(frame: containerView.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self

        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }

        containerView.addSubview(webView)

        // Loading overlay on top of webView, filling the container
        loadingView = NSView(frame: containerView.bounds)
        loadingView.autoresizingMask = [.width, .height]
        loadingView.wantsLayer = true
        loadingView.layer?.backgroundColor = NSColor(
            red: 0.11, green: 0.11, blue: 0.12, alpha: 1.0
        ).cgColor

        // Spinner — use NSAppearance to ensure it's visible on dark background
        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.appearance = NSAppearance(named: .darkAqua)
        spinner.controlSize = .regular
        spinner.sizeToFit()
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimation(nil)
        loadingView.addSubview(spinner)

        // Label
        loadingLabel = NSTextField(labelWithString: "Starting...")
        loadingLabel.font = .systemFont(ofSize: 16, weight: .medium)
        loadingLabel.textColor = .white
        loadingLabel.alignment = .center
        loadingLabel.maximumNumberOfLines = 0
        loadingLabel.preferredMaxLayoutWidth = 500
        loadingLabel.translatesAutoresizingMaskIntoConstraints = false
        loadingView.addSubview(loadingLabel)

        containerView.addSubview(loadingView)

        // Center spinner and label in loading view
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: loadingView.centerYAnchor, constant: -16),
            loadingLabel.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
            loadingLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 12),
            loadingLabel.leadingAnchor.constraint(greaterThanOrEqualTo: loadingView.leadingAnchor, constant: 30),
            loadingLabel.trailingAnchor.constraint(lessThanOrEqualTo: loadingView.trailingAnchor, constant: -30),
        ])
    }

    // MARK: - Public

    /// Update the loading screen status text.
    func updateLoadingStatus(_ message: String) {
        loadingLabel.stringValue = message
    }

    /// Load the web app after the server is ready.
    func loadWebApp(port: Int) {
        loadingLabel.stringValue = "Loading..."
        let baseURL = URL(string: "http://localhost:\(port)")!
        let token = serverManager.authToken

        // Call the login API endpoint first — the server's Set-Cookie response
        // header properly sets the httpOnly cookie in WKWebView's cookie store.
        // This is more reliable than manually injecting cookies.
        if !token.isEmpty {
            let loginURL = URL(string: "http://localhost:\(port)/api/auth/login")!
            var request = URLRequest(url: loginURL)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])

            webView.load(request)

            // After the login POST completes, navigate to the main page.
            // We use a short delay to let the Set-Cookie header be processed.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.webView.load(URLRequest(url: baseURL))
            }
            return
        }

        webView.load(URLRequest(url: baseURL))
    }

    /// Show an error message on the loading overlay.
    func showError(_ message: String) {
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        loadingLabel.stringValue = message
        loadingLabel.textColor = NSColor.systemRed
    }

    /// Reload the current page (called from View → Reload menu).
    @objc func reloadPage(_ sender: Any?) {
        webView.reload()
    }

    // MARK: - WKScriptMessageHandler (SC4 — native screen capture)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "captureScreen" else { return }

        // SC5: JS sends { mode: 'windowPicker' } to trigger the native window picker.
        // All other payloads (including the SC4 empty-body full-screen capture) fall through.
        if let body = message.body as? [String: Any],
           (body["mode"] as? String) == "windowPicker" {
            if #available(macOS 14.0, *) {
                let picker = WindowPickerController()
                windowPickerController = picker  // retain until completion
                picker.present { [weak self] base64PNG in
                    DispatchQueue.main.async {
                        self?.windowPickerController = nil
                        self?.dispatchCaptureResult(base64PNG)
                    }
                }
            } else {
                // macOS 13.x: SCScreenshotManager.captureImage unavailable — degrade
                // gracefully to a full-screen capture rather than failing silently.
                captureScreenNative { [weak self] base64PNG in
                    DispatchQueue.main.async { self?.dispatchCaptureResult(base64PNG) }
                }
            }
            return
        }

        // SC6: JS sends { mode: 'regionPicker' } to trigger the native region selector.
        if let body = message.body as? [String: Any],
           (body["mode"] as? String) == "regionPicker" {
            if #available(macOS 14.0, *) {
                let picker = RegionPickerController()
                regionPickerController = picker  // retain until completion
                picker.present { [weak self] base64PNG in
                    DispatchQueue.main.async {
                        self?.regionPickerController = nil
                        self?.dispatchCaptureResult(base64PNG)
                    }
                }
            } else {
                // macOS 13.x: degrade gracefully to full-screen capture.
                captureScreenNative { [weak self] base64PNG in
                    DispatchQueue.main.async { self?.dispatchCaptureResult(base64PNG) }
                }
            }
            return
        }

        // SC4 default: full-screen capture.
        captureScreenNative { [weak self] base64PNG in
            DispatchQueue.main.async {
                self?.dispatchCaptureResult(base64PNG)
            }
        }
    }

    // MARK: - Native Screen Capture (SC4)

    /// Entry point: routes to ScreenCaptureKit (macOS 14+) or CoreGraphics fallback (macOS 13).
    private func captureScreenNative(completion: @escaping (String?) -> Void) {
        if #available(macOS 14.0, *) {
            captureWithScreenCaptureKit(completion: completion)
        } else {
            // macOS 13.x: CGWindowListCreateImage is deprecated on 14+ but functional here.
            // Requires Screen Recording permission — same grant the user already gave for SCKit.
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let result = self?.captureWithCoreGraphics()
                completion(result)
            }
        }
    }

    /// ScreenCaptureKit path — macOS 14.0+.
    /// Captures the primary display as a PNG and returns it as a base64 string.
    @available(macOS 14.0, *)
    private func captureWithScreenCaptureKit(completion: @escaping (String?) -> Void) {
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: true
                )
                guard let display = content.displays.first else {
                    NSLog("[SC4] No displays found")
                    completion(nil)
                    return
                }

                let filter = SCContentFilter(display: display, excludingWindows: [])
                let streamConfig = SCStreamConfiguration()
                streamConfig.width = display.width
                streamConfig.height = display.height

                let cgImage = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: streamConfig
                )
                completion(pngBase64(from: cgImage))
            } catch {
                NSLog("[SC4] ScreenCaptureKit capture failed: %@", error.localizedDescription)
                completion(nil)
            }
        }
    }

    /// CoreGraphics fallback for macOS 13.x.
    /// CGDisplayCreateImage captures the primary display — available since macOS 10.6,
    /// not deprecated. Requires Screen Recording permission on macOS 10.15+.
    private func captureWithCoreGraphics() -> String? {
        let displayID = CGMainDisplayID()
        guard let cgImage = CGDisplayCreateImage(displayID) else {
            NSLog("[SC4] CGDisplayCreateImage returned nil — check Screen Recording permission")
            return nil
        }
        return pngBase64(from: cgImage)
    }

    /// Convert a CGImage to a base64-encoded PNG string.
    private func pngBase64(from cgImage: CGImage) -> String? {
        let size = NSSize(width: cgImage.width, height: cgImage.height)
        let nsImage = NSImage(cgImage: cgImage, size: size)
        guard
            let tiff = nsImage.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiff),
            let pngData = bitmap.representation(using: .png, properties: [:])
        else {
            NSLog("[SC4] Failed to encode PNG")
            return nil
        }
        return pngData.base64EncodedString()
    }

    /// Fire a 'medusaNativeCapture' CustomEvent on the JS window with the capture result.
    /// JS in captureScreen.ts listens for this event to resolve the capture promise.
    private func dispatchCaptureResult(_ base64: String?) {
        let js: String
        if let data = base64 {
            // base64 characters (A-Z, a-z, 0-9, +, /, =) are safe in a JS string literal.
            js = "window.dispatchEvent(new CustomEvent('medusaNativeCapture', { detail: { data: '\(data)' } }));"
        } else {
            js = "window.dispatchEvent(new CustomEvent('medusaNativeCapture', { detail: { error: 'capture_failed' } }));"
        }
        webView.evaluateJavaScript(js) { _, err in
            if let err = err {
                NSLog("[SC4] evaluateJavaScript error: %@", err.localizedDescription)
            }
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadingView.removeFromSuperview()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError("Page failed to load:\n\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError("Could not connect to server:\n\(error.localizedDescription)")
    }

    // MARK: - WKUIDelegate

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // Required for <input type="file"> to work inside WKWebView.
    // Without this delegate method, WKWebView silently drops all file picker requests.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.image]
        panel.message = "Select an image to attach"

        guard let window = webView.window else {
            completionHandler(nil)
            return
        }

        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}
