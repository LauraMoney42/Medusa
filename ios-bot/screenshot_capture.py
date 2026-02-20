"""
IT5 — Screenshot capture module.

Captures screenshots from iOS simulators via xcrun simctl, organizes them
by device size and screen name, and validates basic file integrity.

Designed for both ad-hoc capture and App Store screenshot generation workflows.
"""

from __future__ import annotations

import os
import time
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

import simulator as sim


# App Store required device sizes (name → approximate screen diagonal)
APP_STORE_DEVICES = [
    "iPhone 17 Pro Max",   # 6.7" — required for App Store
    "iPhone 16 Plus",      # 6.5" — required for App Store
    "iPhone 8 Plus",       # 5.5" — required for App Store (older size)
]

# Default output directory for screenshots
DEFAULT_OUTPUT_DIR = Path("/tmp/ios-bot-screenshots")


@dataclass
class Screenshot:
    """Metadata + path for a single captured screenshot."""
    path: str
    device_name: str
    screen_name: str
    udid: str
    timestamp: str
    file_size_bytes: int
    width_px: int = 0
    height_px: int = 0

    @property
    def filename(self) -> str:
        return Path(self.path).name

    @property
    def is_valid(self) -> bool:
        """Basic integrity check: file exists and is a non-empty PNG."""
        p = Path(self.path)
        return p.exists() and p.suffix.lower() == ".png" and self.file_size_bytes > 0


@dataclass
class CaptureSession:
    """Results from a multi-screen, multi-device capture run."""
    screenshots: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    output_dir: str = ""

    @property
    def success_count(self) -> int:
        return len(self.screenshots)

    @property
    def error_count(self) -> int:
        return len(self.errors)

    @property
    def all_valid(self) -> bool:
        return self.error_count == 0 and all(s.is_valid for s in self.screenshots)


def _get_image_dimensions(path: str) -> tuple:
    """Read PNG dimensions from file header (no Pillow needed)."""
    try:
        with open(path, "rb") as f:
            f.read(8)   # PNG signature
            f.read(4)   # chunk length
            f.read(4)   # IHDR
            width = int.from_bytes(f.read(4), "big")
            height = int.from_bytes(f.read(4), "big")
            return width, height
    except Exception:
        return 0, 0


def _safe_device_name(name: str) -> str:
    """Convert device name to a filesystem-safe string."""
    return name.replace(" ", "_").replace("/", "-").lower()


def capture_screen(
    udid: str,
    device_name: str,
    screen_name: str,
    output_dir: Path,
    wait_before_capture: float = 1.0,
) -> Screenshot:
    """
    Capture a single screenshot from a booted simulator.

    Args:
        udid: Simulator UDID.
        device_name: Human-readable device name (used in filename).
        screen_name: Name of the screen/state being captured (e.g. "dashboard", "settings").
        output_dir: Directory to write the PNG file.
        wait_before_capture: Seconds to wait before capturing (allow UI to settle).

    Returns:
        Screenshot dataclass with path and metadata.

    Raises:
        RuntimeError: If simctl fails.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_device = _safe_device_name(device_name)
    safe_screen = screen_name.replace(" ", "_").lower()
    filename = f"{safe_device}__{safe_screen}__{timestamp}.png"

    # Organise under output_dir/device_name/
    device_dir = output_dir / safe_device
    device_dir.mkdir(parents=True, exist_ok=True)
    full_path = str(device_dir / filename)

    if wait_before_capture > 0:
        time.sleep(wait_before_capture)

    sim.screenshot(udid, full_path)

    file_size = os.path.getsize(full_path)
    width, height = _get_image_dimensions(full_path)

    return Screenshot(
        path=full_path,
        device_name=device_name,
        screen_name=screen_name,
        udid=udid,
        timestamp=timestamp,
        file_size_bytes=file_size,
        width_px=width,
        height_px=height,
    )


def capture_screens(
    udid: str,
    device_name: str,
    screen_names: list,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    navigate_to_screen=None,
    wait_between: float = 1.5,
) -> CaptureSession:
    """
    Capture screenshots of multiple named screens on a single simulator.

    Args:
        udid: Simulator UDID.
        device_name: Human-readable device name.
        screen_names: List of screen names to capture (e.g. ["dashboard", "data", "settings"]).
        output_dir: Root directory for output.
        navigate_to_screen: Optional callable(screen_name) that navigates the app
                            to the given screen before capturing. If None, captures
                            whatever is currently on screen.
        wait_between: Seconds to wait between captures.

    Returns:
        CaptureSession with all results.
    """
    session = CaptureSession(output_dir=str(output_dir))

    for screen_name in screen_names:
        try:
            if navigate_to_screen:
                navigate_to_screen(screen_name)

            shot = capture_screen(
                udid=udid,
                device_name=device_name,
                screen_name=screen_name,
                output_dir=output_dir,
                wait_before_capture=wait_between,
            )
            session.screenshots.append(shot)
        except Exception as e:
            session.errors.append({
                "device": device_name,
                "screen": screen_name,
                "error": str(e),
            })

    return session


def validate_app_store_requirements(screenshot: Screenshot) -> list:
    """
    Check if a screenshot meets App Store submission requirements.

    App Store requires:
    - PNG format
    - Minimum resolution for the device size (no upscaling)
    - No alpha/transparency (simctl output is always opaque — fine)

    Returns list of failure reasons (empty = passes).
    """
    failures = []

    if not Path(screenshot.path).exists():
        failures.append("File does not exist")
        return failures

    if Path(screenshot.path).suffix.lower() != ".png":
        failures.append("Must be PNG format")

    if screenshot.file_size_bytes < 10_000:
        failures.append(f"File too small ({screenshot.file_size_bytes} bytes) — likely corrupt")

    # App Store minimum resolutions by device type (approximate)
    min_resolutions = {
        "6.7": (1290, 2796),   # iPhone Pro Max
        "6.5": (1242, 2688),   # iPhone Plus (older)
        "5.5": (1242, 2208),   # iPhone 8 Plus
    }

    w, h = screenshot.width_px, screenshot.height_px
    if w > 0 and h > 0:
        # Ensure portrait orientation (swap if landscape)
        if w > h:
            w, h = h, w
        # Check if it meets at least one standard size
        meets_standard = any(
            w >= req_w and h >= req_h
            for req_w, req_h in min_resolutions.values()
        )
        if not meets_standard:
            failures.append(
                f"Resolution {screenshot.width_px}×{screenshot.height_px} may be too small for App Store"
            )

    return failures


def print_session_summary(session: CaptureSession):
    """Print a human-readable summary of a capture session."""
    print(f"\n📸 Capture Session Summary")
    print(f"   Output dir: {session.output_dir}")
    print(f"   Captured:   {session.success_count} screenshots")
    if session.error_count:
        print(f"   Errors:     {session.error_count}")

    if session.screenshots:
        print("\n   Screenshots:")
        for s in session.screenshots:
            dims = f"{s.width_px}×{s.height_px}" if s.width_px else "unknown dims"
            size_kb = s.file_size_bytes // 1024
            status = "✅" if s.is_valid else "❌"
            print(f"   {status} [{s.device_name}] {s.screen_name}")
            print(f"      {dims}  {size_kb}KB  → {s.filename}")

    if session.errors:
        print("\n   Errors:")
        for e in session.errors:
            print(f"   ❌ [{e['device']}] {e['screen']}: {e['error']}")


if __name__ == "__main__":
    import sys

    print("IT5 — Screenshot Capture Module Verification")
    print()

    # Get booted simulator
    booted = sim.get_booted()
    if not booted:
        print("No booted simulator found. Boot one first.")
        sys.exit(1)

    sim.open_simulator_app()
    time.sleep(2.0)  # ensure display is initialized

    print(f"Using simulator: {booted.name} ({booted.udid[:8]}...)")
    print()

    # Capture multiple "screens" (in practice, the bot would navigate between them)
    # For IT5 verification, we capture the same simulator state under different names
    output_dir = Path("/tmp/ios-bot-screenshots")
    screen_names = ["homescreen", "overview", "detail"]

    print(f"Capturing {len(screen_names)} screens...")
    session = capture_screens(
        udid=booted.udid,
        device_name=booted.name,
        screen_names=screen_names,
        output_dir=output_dir,
        wait_between=0.5,
    )

    print_session_summary(session)

    # Validate App Store requirements
    if session.screenshots:
        print("\n📋 App Store Validation:")
        for shot in session.screenshots:
            failures = validate_app_store_requirements(shot)
            if failures:
                print(f"   ⚠️  {shot.screen_name}: {', '.join(failures)}")
            else:
                print(f"   ✅ {shot.screen_name}: passes App Store requirements")

    print()
    print(f"IT5 verification complete. {'✅ All good.' if session.all_valid else '⚠️ See errors above.'}")
    sys.exit(0 if session.all_valid else 1)
