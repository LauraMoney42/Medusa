import Cocoa
import ScreenCaptureKit

// MARK: - WindowPickerController (SC5)
//
// Presents a system-wide window picker overlay.
// A single NSWindow spans all screens (same design as SC6's RegionPickerController)
// to avoid per-screen event-routing complexity.
//
// Hover detection uses NSEvent.addLocalMonitorForEvents rather than NSTrackingArea.
// NSTrackingArea's mouseMoved delivery has edge cases with screenSaver-level overlay
// windows; the local event monitor is more reliable for this use case.
//
// SCWindow.frame is in AppKit screen coordinates (Y-up, same as NSEvent.mouseLocation
// and NSScreen.frame) — no Y-flip needed, just translate by the overlay frame origin.
//
// Requires macOS 14.0+ for SCScreenshotManager.captureImage.

@available(macOS 14.0, *)
final class WindowPickerController: NSObject {
    private var overlayWindow: NSWindow?
    private var pickerView: WindowPickerView?
    private var completion: ((String?) -> Void)?
    private var keyMonitor: Any?
    private var mouseMonitor: Any?

    // MARK: - Public

    func present(completion: @escaping (String?) -> Void) {
        self.completion = completion
        Task { @MainActor in
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: true
                )
                // Filter out invisible elements (dock badges, menu-bar extras, etc.)
                let windows = content.windows.filter {
                    $0.frame.width > 10 && $0.frame.height > 10
                }
                self.showOverlay(for: windows)
            } catch {
                NSLog("[SC5] Window enumeration failed: %@", error.localizedDescription)
                completion(nil)
            }
        }
    }

    // MARK: - Private

    private func showOverlay(for windows: [SCWindow]) {
        let allScreensFrame = NSScreen.screens.reduce(NSRect.zero) { $0.union($1.frame) }

        let view = WindowPickerView(scWindows: windows, overlayFrame: allScreensFrame)
        view.onSelect = { [weak self] selected in
            self?.dismiss()
            if let win = selected {
                self?.capture(win)
            } else {
                self?.finish(nil)
            }
        }

        let window = NSWindow(
            contentRect: allScreensFrame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.level = .screenSaver
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = false
        window.ignoresMouseEvents = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.contentView = view
        window.makeKeyAndOrderFront(nil)

        overlayWindow = window
        pickerView   = view

        // Local event monitor for mouse movement — more reliable than NSTrackingArea
        // for screenSaver-level overlay windows. NSEvent.mouseLocation gives the cursor
        // position in global AppKit screen coordinates (Y-up), which matches SCWindow.frame.
        mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: .mouseMoved) { [weak self] event in
            self?.pickerView?.updateHover(at: NSEvent.mouseLocation)
            return event
        }

        // Escape key cancels.
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {
                self?.dismiss()
                self?.finish(nil)
                return nil
            }
            return event
        }
    }

    private func dismiss() {
        overlayWindow?.orderOut(nil)
        overlayWindow = nil
        pickerView    = nil
        if let m = mouseMonitor { NSEvent.removeMonitor(m); mouseMonitor = nil }
        if let k = keyMonitor   { NSEvent.removeMonitor(k); keyMonitor   = nil }
    }

    private func capture(_ scWindow: SCWindow) {
        Task {
            do {
                let filter = SCContentFilter(desktopIndependentWindow: scWindow)
                let config = SCStreamConfiguration()
                // SCWindow.frame is in logical points; multiply by 2 for Retina.
                config.width  = Int(scWindow.frame.width)  * 2
                config.height = Int(scWindow.frame.height) * 2
                let cgImage = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: config
                )
                await MainActor.run { self.finish(self.pngBase64(from: cgImage)) }
            } catch {
                NSLog("[SC5] Capture failed: %@", error.localizedDescription)
                await MainActor.run { self.finish(nil) }
            }
        }
    }

    private func finish(_ base64: String?) {
        completion?(base64)
        completion = nil
    }

    private func pngBase64(from cgImage: CGImage) -> String? {
        let size = NSSize(width: cgImage.width, height: cgImage.height)
        let nsImage = NSImage(cgImage: cgImage, size: size)
        guard
            let tiff   = nsImage.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiff),
            let png    = bitmap.representation(using: .png, properties: [:])
        else {
            NSLog("[SC5] PNG encoding failed")
            return nil
        }
        return png.base64EncodedString()
    }
}

// MARK: - WindowPickerView

@available(macOS 14.0, *)
final class WindowPickerView: NSView {
    var onSelect: ((SCWindow?) -> Void)?

    private let scWindows: [SCWindow]
    // SCWindow.frame is in AppKit screen coordinates (Y-up, origin = bottom-left of
    // primary display). To convert to view-local coordinates, subtract the overlay's
    // origin (allScreensFrame.origin). No Y-flip required.
    private let viewFrames: [NSRect]
    private var hoveredIndex: Int = -1

    init(scWindows: [SCWindow], overlayFrame: NSRect) {
        self.scWindows = scWindows
        self.viewFrames = scWindows.map { win in
            NSRect(
                x:      win.frame.minX - overlayFrame.minX,
                y:      win.frame.minY - overlayFrame.minY,
                width:  win.frame.width,
                height: win.frame.height
            )
        }
        super.init(frame: overlayFrame)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    // MARK: - Hover (called by WindowPickerController's mouse monitor)

    /// Update hover state from a global AppKit screen coordinate (NSEvent.mouseLocation).
    func updateHover(at screenLocation: NSPoint) {
        // Convert global AppKit screen coords → view-local coords.
        // The overlay window's frame origin is overlayFrame.origin (in screen coords),
        // but the view's bounds always start at (0,0). So view-local = screen - windowOrigin.
        guard let windowOrigin = self.window?.frame.origin else { return }
        let viewPoint = NSPoint(
            x: screenLocation.x - windowOrigin.x,
            y: screenLocation.y - windowOrigin.y
        )

        // SCWindows are ordered front-to-back; first hit = topmost visible window.
        let newIndex = viewFrames.firstIndex(where: { $0.contains(viewPoint) }) ?? -1
        if newIndex != hoveredIndex {
            hoveredIndex = newIndex
            needsDisplay = true
        }
    }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        // Subtle dim to signal picker mode is active.
        ctx.setFillColor(NSColor.black.withAlphaComponent(0.20).cgColor)
        ctx.fill(bounds)

        guard hoveredIndex >= 0, hoveredIndex < viewFrames.count else { return }
        let rect = viewFrames[hoveredIndex]

        // Reveal the hovered window at full brightness.
        ctx.clear(rect)

        // Blue tint + border.
        ctx.setFillColor(NSColor.systemBlue.withAlphaComponent(0.15).cgColor)
        ctx.fill(rect)

        let bw: CGFloat = 4
        ctx.setStrokeColor(NSColor.systemBlue.cgColor)
        ctx.setLineWidth(bw)
        ctx.stroke(rect.insetBy(dx: bw / 2, dy: bw / 2))
    }

    // MARK: - Click

    override func mouseDown(with event: NSEvent) {
        guard hoveredIndex >= 0, hoveredIndex < scWindows.count else { return }
        onSelect?(scWindows[hoveredIndex])
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .arrow)
    }
}
