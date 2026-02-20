import Cocoa
import ScreenCaptureKit

// MARK: - RegionPickerController (SC6)
//
// Presents a system-wide fullscreen overlay for drag-to-select region capture.
// A single NSWindow spans all connected screens so the user can select any region
// anywhere on their desktop, including content outside the Medusa window.
//
// Capture uses SCStreamConfiguration.sourceRect to crop to the selected region
// directly, avoiding the need to capture a full display and crop manually.
// Requires macOS 14.0+ for SCScreenshotManager.captureImage (same as SC5).
// Callers on macOS 13.x should fall back to full-screen capture.

@available(macOS 14.0, *)
final class RegionPickerController: NSObject {
    private var overlayWindow: NSWindow?
    private var completion: ((String?) -> Void)?
    private var keyMonitor: Any?

    // MARK: - Public

    /// Present the region picker overlay and invoke `completion` with a base64-encoded
    /// PNG of the selected region, or nil if the user cancels or the capture fails.
    func present(completion: @escaping (String?) -> Void) {
        self.completion = completion
        DispatchQueue.main.async { self.showOverlay() }
    }

    // MARK: - Private

    private func showOverlay() {
        // A single window spanning all screens gives seamless cross-monitor drag.
        let allScreensFrame = NSScreen.screens.reduce(NSRect.zero) { $0.union($1.frame) }

        let view = RegionPickerView(overlayFrame: allScreensFrame)
        view.onRegionSelected = { [weak self] quartzRect in
            self?.dismiss()
            if let rect = quartzRect {
                self?.capture(quartzRect: rect)
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
        // Appear on all Spaces and in fullscreen mode.
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        overlayWindow = window

        // Escape cancels without capturing.
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { // Escape
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
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
    }

    private func capture(quartzRect: CGRect) {
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: true
                )

                // Find the display whose frame contains the center of the selection.
                // For selections that span displays, the display with the center wins.
                // This handles 99% of real-world use cases cleanly.
                let center = CGPoint(x: quartzRect.midX, y: quartzRect.midY)
                guard let display = content.displays.first(where: { $0.frame.contains(center) })
                                 ?? content.displays.first
                else {
                    NSLog("[SC6] No display found for selection rect %@", "\(quartzRect)")
                    await MainActor.run { self.finish(nil) }
                    return
                }

                // SCStreamConfiguration.sourceRect is in display-local Quartz coordinates:
                // same Y-down convention as global Quartz, just offset by the display origin.
                let localRect = CGRect(
                    x: quartzRect.minX - display.frame.minX,
                    y: quartzRect.minY - display.frame.minY,
                    width:  quartzRect.width,
                    height: quartzRect.height
                )

                let filter = SCContentFilter(display: display, excludingWindows: [])
                let config = SCStreamConfiguration()
                config.sourceRect = localRect
                // Capture at 2× for Retina — quartzRect is in logical points.
                config.width  = Int(quartzRect.width)  * 2
                config.height = Int(quartzRect.height) * 2

                let cgImage = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: config
                )
                await MainActor.run { self.finish(self.pngBase64(from: cgImage)) }
            } catch {
                NSLog("[SC6] Capture failed: %@", error.localizedDescription)
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
            NSLog("[SC6] PNG encoding failed")
            return nil
        }
        return png.base64EncodedString()
    }
}

// MARK: - RegionPickerView

@available(macOS 14.0, *)
private final class RegionPickerView: NSView {
    /// Non-nil CGRect (in Quartz screen coords) = region confirmed; nil = cancelled.
    var onRegionSelected: ((CGRect?) -> Void)?

    /// The overlay window's frame in AppKit screen coordinates.
    private let overlayFrame: NSRect

    private var dragStart: NSPoint?   // View-local AppKit coords (Y up)
    private var dragCurrent: NSPoint? // View-local AppKit coords (Y up)

    // MARK: Init

    init(overlayFrame: NSRect) {
        self.overlayFrame = overlayFrame
        super.init(frame: overlayFrame)

        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseMoved, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        ))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        // Dim the entire overlay — 40% matches Apple's own cmd+shift+4 screenshot tool.
        ctx.setFillColor(NSColor.black.withAlphaComponent(0.40).cgColor)
        ctx.fill(bounds)

        // While dragging, punch a clear hole so the selected region shows at full
        // brightness, and draw a dashed white border (standard macOS screenshot style).
        if let start = dragStart, let current = dragCurrent {
            let sel = NSRect.from(start, current)
            guard sel.width > 1, sel.height > 1 else { return }

            ctx.clear(sel)

            ctx.setStrokeColor(NSColor.white.cgColor)
            ctx.setLineWidth(1.5)
            ctx.setLineDash(phase: 0, lengths: [6, 4])
            ctx.stroke(sel.insetBy(dx: 0.75, dy: 0.75))
        }
    }

    // MARK: Mouse events

    override func mouseDown(with event: NSEvent) {
        dragStart   = convert(event.locationInWindow, from: nil)
        dragCurrent = dragStart
        NSCursor.crosshair.set()
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        dragCurrent = convert(event.locationInWindow, from: nil)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        dragCurrent = convert(event.locationInWindow, from: nil)

        guard let start = dragStart, let current = dragCurrent else {
            onRegionSelected?(nil)
            return
        }

        let sel = NSRect.from(start, current)

        // Ignore accidental single-clicks — require a meaningful drag.
        guard sel.width > 5, sel.height > 5 else {
            reset()
            return
        }

        onRegionSelected?(appKitViewRectToQuartz(sel))
    }

    override func mouseMoved(with event: NSEvent) {
        NSCursor.crosshair.set()
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
    }

    // MARK: Coordinate conversion

    /// Convert a rect from this view's local AppKit coordinate space to global
    /// Quartz screen coordinates (origin at top-left of primary display, Y down).
    ///
    /// Conversion steps:
    ///   1. View-local → AppKit screen: add the overlay window's frame origin.
    ///   2. AppKit screen → Quartz: flip Y using the primary display height.
    private func appKitViewRectToQuartz(_ rect: NSRect) -> CGRect {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? bounds.height

        // Step 1: view-local → AppKit screen coordinates
        let screenX = rect.minX + overlayFrame.minX
        let screenY = rect.minY + overlayFrame.minY

        // Step 2: flip Y — Quartz top edge = primaryHeight − AppKit top edge
        let quartzY = primaryHeight - (screenY + rect.height)

        return CGRect(x: screenX, y: quartzY, width: rect.width, height: rect.height)
    }

    private func reset() {
        dragStart   = nil
        dragCurrent = nil
        needsDisplay = true
    }
}

// MARK: - NSRect convenience

@available(macOS 14.0, *)
private extension NSRect {
    /// Build a normalized rect from two arbitrary corner points (order-independent).
    static func from(_ a: NSPoint, _ b: NSPoint) -> NSRect {
        NSRect(
            x:      min(a.x, b.x),
            y:      min(a.y, b.y),
            width:  abs(a.x - b.x),
            height: abs(a.y - b.y)
        )
    }
}
