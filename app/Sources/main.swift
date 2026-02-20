import Cocoa

// MARK: - AppDelegate

class AppDelegate: NSObject, NSApplicationDelegate {
    var serverManager: ServerManager!
    var webViewController: WebViewController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Resolve paths relative to the .app bundle location.
        // Binary lives at: claude-chat/app/Medusa.app/Contents/MacOS/Medusa
        // Bundle is:        claude-chat/app/Medusa.app/
        // App dir is:       claude-chat/app/
        // Project root is:  claude-chat/
        let bundleURL = Bundle.main.bundleURL          // Medusa.app/
        let appDir = bundleURL.deletingLastPathComponent() // claude-chat/app/
        let projectRoot = appDir.deletingLastPathComponent() // claude-chat/

        serverManager = ServerManager(
            projectRoot: projectRoot.path,
            serverDir: projectRoot.appendingPathComponent("server").path,
            envPath: projectRoot.appendingPathComponent(".env").path
        )

        // Create the window (shows loading screen immediately)
        webViewController = WebViewController(serverManager: serverManager)
        webViewController.showWindow(nil)

        // Wire up status updates so the loading screen shows build progress
        serverManager.onStatus = { [weak self] message in
            self?.webViewController.updateLoadingStatus(message)
        }

        // Start the Node.js server (auto-builds if needed), then load the web view
        serverManager.start { [weak self] result in
            switch result {
            case .success(let port):
                self?.webViewController.loadWebApp(port: port)
            case .failure(let error):
                self?.webViewController.showError(error.localizedDescription)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverManager?.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

// MARK: - Menu Bar

func setupMainMenu() {
    let mainMenu = NSMenu()

    // Application menu
    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)
    let appMenu = NSMenu()
    appMenuItem.submenu = appMenu
    appMenu.addItem(withTitle: "About Medusa",
                    action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                    keyEquivalent: "")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Hide Medusa",
                    action: #selector(NSApplication.hide(_:)),
                    keyEquivalent: "h")
    let hideOthers = appMenu.addItem(withTitle: "Hide Others",
                                     action: #selector(NSApplication.hideOtherApplications(_:)),
                                     keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(withTitle: "Show All",
                    action: #selector(NSApplication.unhideAllApplications(_:)),
                    keyEquivalent: "")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Quit Medusa",
                    action: #selector(NSApplication.terminate(_:)),
                    keyEquivalent: "q")

    // Edit menu (required for copy/paste in WKWebView)
    let editMenuItem = NSMenuItem()
    mainMenu.addItem(editMenuItem)
    let editMenu = NSMenu(title: "Edit")
    editMenuItem.submenu = editMenu
    editMenu.addItem(withTitle: "Undo",
                     action: Selector(("undo:")),
                     keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo",
                     action: Selector(("redo:")),
                     keyEquivalent: "Z")
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(withTitle: "Cut",
                     action: #selector(NSText.cut(_:)),
                     keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy",
                     action: #selector(NSText.copy(_:)),
                     keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste",
                     action: #selector(NSText.paste(_:)),
                     keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All",
                     action: #selector(NSText.selectAll(_:)),
                     keyEquivalent: "a")

    // View menu (Reload)
    let viewMenuItem = NSMenuItem()
    mainMenu.addItem(viewMenuItem)
    let viewMenu = NSMenu(title: "View")
    viewMenuItem.submenu = viewMenu
    viewMenu.addItem(withTitle: "Reload",
                     action: #selector(WebViewController.reloadPage(_:)),
                     keyEquivalent: "r")

    // Window menu
    let windowMenuItem = NSMenuItem()
    mainMenu.addItem(windowMenuItem)
    let windowMenu = NSMenu(title: "Window")
    windowMenuItem.submenu = windowMenu
    windowMenu.addItem(withTitle: "Minimize",
                       action: #selector(NSWindow.performMiniaturize(_:)),
                       keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Zoom",
                       action: #selector(NSWindow.performZoom(_:)),
                       keyEquivalent: "")

    NSApplication.shared.mainMenu = mainMenu
    NSApplication.shared.windowsMenu = windowMenu
}

// MARK: - Application Bootstrap

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)

setupMainMenu()

app.activate(ignoringOtherApps: true)
app.run()
