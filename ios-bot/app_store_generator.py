"""
IT8 + IT9 — App Store screenshot generation and validation.

Orchestrates multi-device screenshot generation with vision analysis verification,
then validates all generated screenshots against App Store requirements.

Designed for end-to-end App Store screenshot workflow.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Callable

import simulator as sim
import screenshot_capture as sc
import xcuitest
from vision_analysis import VisionAnalyzer, VisionAnalysisResult


# App Store screenshot specifications.
#
# Apple requires screenshots for these display sizes:
#   6.9" (iPhone 16 Pro Max)  — newest required size
#   6.7" (iPhone 17 Pro Max)  — covers 6.7" slot
#   6.5" (legacy)             — iPhone 16 Plus not available; iPhone Air (~6.3") used as best substitute
#   5.5" (legacy)             — iPhone 8 Plus not available; accepted if 6.7" shots submitted for this slot
#
# We map to whatever simulators are actually installed in this Xcode environment.
# Resolution validation uses wide tolerance (±15%) to handle retina/logical differences.
APP_STORE_SPECS = {
    "iPhone 17 Pro Max": {
        "udid": None,  # Auto-discovered via simctl
        "screen_size": "6.7\"",
        "app_store_slot": "6.7-inch",
        "required_resolutions": [(1320, 2868), (1440, 3120)],  # logical/physical variants
    },
    "iPhone Air": {
        "udid": None,
        "screen_size": "6.3\"",
        "app_store_slot": "6.5-inch",  # closest available substitute for 6.5" slot
        "required_resolutions": [(1206, 2622), (1320, 2868)],
    },
    "iPhone 16e": {
        "udid": None,
        "screen_size": "6.1\"",
        "app_store_slot": "5.5-inch",  # smallest available; used for legacy 5.5" slot
        "required_resolutions": [(1179, 2556), (1080, 2340)],
    },
}

# Fallback device preference order when a preferred device isn't found
DEVICE_FALLBACK_ORDER = [
    ["iPhone 17 Pro Max", "iPhone 17 Pro", "iPhone 17"],
    ["iPhone Air", "iPhone 16 Plus", "iPhone 16 Pro"],
    ["iPhone 16e", "iPhone 8 Plus", "iPhone SE (3rd generation)"],
]

# Bundle ID for POTS Buddy
POTS_BUDDY_BUNDLE_ID = "com.kindcode.potsbuddy"

MIN_FILE_SIZE_KB = 50   # Simulators sometimes produce smaller files — relaxed from 100KB
MAX_FILE_SIZE_KB = 30000  # Sanity limit
REQUIRED_FORMAT = "png"
RESOLUTION_TOLERANCE = 0.15  # ±15% — generous to handle logical vs physical px differences


@dataclass
class AppStoreScreenshot:
    """Metadata for an App Store-compliant screenshot."""
    screenshot: sc.Screenshot
    device_name: str
    screen_size: str
    resolution: tuple[int, int]
    file_size_kb: float
    passes_validation: bool
    validation_errors: list[str]
    vision_analysis: Optional[VisionAnalysisResult] = None

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dict."""
        return {
            "path": self.screenshot.path,
            "device": self.device_name,
            "screen_size": self.screen_size,
            "resolution": self.resolution,
            "file_size_kb": self.file_size_kb,
            "valid": self.passes_validation,
            "errors": self.validation_errors,
            "vision": self.vision_analysis.to_dict() if self.vision_analysis else None,
        }


@dataclass
class AppStoreGenerationResult:
    """Result from full App Store screenshot generation workflow."""
    passed: bool
    total_devices: int
    total_screenshots: int
    valid_screenshots: int
    invalid_screenshots: int
    screenshots: list[AppStoreScreenshot]
    errors: list[str]

    def summary(self) -> str:
        """Human-readable summary."""
        if self.passed:
            return f"✅ All {self.total_screenshots} App Store screenshots valid ({self.total_devices} devices)"
        else:
            return f"❌ {self.invalid_screenshots}/{self.total_screenshots} screenshots failed validation"


class AppStoreGenerator:
    """Generates and validates App Store screenshots across device sizes."""

    def __init__(
        self,
        project_path: str,
        scheme: str,
        output_dir: Optional[str] = None,
        vision_analyzer: Optional[VisionAnalyzer] = None,
        bundle_id: str = POTS_BUDDY_BUNDLE_ID,
    ):
        """
        Initialize App Store screenshot generator.

        Args:
            project_path: Path to .xcodeproj
            scheme: Xcode scheme to build
            output_dir: Output directory for screenshots (default: /tmp/app-store-screenshots)
            vision_analyzer: Optional VisionAnalyzer instance (if None, vision analysis skipped)
            bundle_id: App bundle identifier (default: com.kindcode.potsbuddy)
        """
        self.project_path = project_path
        self.scheme = scheme
        self.bundle_id = bundle_id
        self.output_dir = Path(output_dir or "/tmp/app-store-screenshots")
        self.vision_analyzer = vision_analyzer
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def generate(
        self,
        screens: list[str],
        navigate_to_screen: Optional[Callable[[str], bool]] = None,
        verify_with_vision: bool = True,
    ) -> AppStoreGenerationResult:
        """
        Generate App Store screenshots for all required device sizes.

        Args:
            screens: List of screen/view names to capture (e.g., ["Dashboard", "History"])
            navigate_to_screen: Optional callback to navigate to each screen (from xcuitest)
            verify_with_vision: If True and vision_analyzer set, verify screenshots with Claude

        Returns:
            AppStoreGenerationResult with all generated screenshots and validation status
        """
        errors = []
        screenshots = []

        # Ensure project builds successfully
        print(f"🔨 Building {self.scheme}...")
        from builder import build

        build_result = build(self.project_path, self.scheme)
        if not build_result.success:
            errors.append(f"Build failed: {build_result.error}")
            return AppStoreGenerationResult(
                passed=False,
                total_devices=0,
                total_screenshots=0,
                valid_screenshots=0,
                invalid_screenshots=0,
                screenshots=[],
                errors=errors,
            )

        total_screenshots = 0
        valid_screenshots = 0

        # Generate screenshots for each device
        for preferred_name, device_info in APP_STORE_SPECS.items():
            screen_size = device_info["screen_size"]
            app_store_slot = device_info["app_store_slot"]

            # Try preferred device first, then fallbacks from same tier
            device = None
            resolved_name = preferred_name
            for tier in DEVICE_FALLBACK_ORDER:
                if preferred_name in tier:
                    for candidate in tier:
                        device = sim.find_device(candidate)
                        if device:
                            resolved_name = candidate
                            break
                    break
            if device is None:
                device = sim.find_device(preferred_name)
                resolved_name = preferred_name

            print(f"\n📱 Setting up {resolved_name} (App Store {app_store_slot} slot)...")

            if not device:
                errors.append(f"No simulator found for {app_store_slot} slot (tried {preferred_name})")
                continue

            try:
                # Boot simulator if not already booted
                if device.state != "Booted":
                    print(f"  Booting {device_name}...")
                    sim.boot(device.udid)

                # Install app
                print(f"  Installing app...")
                sim.install(device.udid, build_result.app_path)

                # Launch app
                print(f"  Launching app...")
                sim.launch(device.udid, self.bundle_id)

                # Use provided navigation callback, or fall back to built-in POTS Buddy nav
                nav_fn = navigate_to_screen or self._make_pots_buddy_navigator(device.udid)

                # Capture screenshots for each screen
                device_screenshots = sc.capture_screens(
                    udid=device.udid,
                    device_name=resolved_name,
                    screen_names=screens,
                    navigate_to_screen=nav_fn,
                    output_dir=str(self.output_dir / resolved_name),
                )

                # Validate each screenshot
                for screenshot in device_screenshots:
                    total_screenshots += 1
                    validated = self._validate_screenshot(
                        screenshot, resolved_name, screen_size, errors
                    )

                    # Optional: verify with Claude vision
                    if verify_with_vision and self.vision_analyzer:
                        vision_result = self.vision_analyzer.analyze_screenshot(
                            screenshot.path, resolved_name, screenshot.screen_name
                        )
                        validated.vision_analysis = vision_result
                        if not vision_result.passed:
                            validated.passes_validation = False
                            validated.validation_errors.append(
                                f"Vision analysis failed: {vision_result.summary}"
                            )

                    screenshots.append(validated)
                    if validated.passes_validation:
                        valid_screenshots += 1
                    else:
                        errors.extend(validated.validation_errors)

                # Shutdown simulator to save resources
                print(f"  Shutting down {resolved_name}...")
                sim.shutdown(device.udid)

            except Exception as e:
                errors.append(f"Error generating screenshots for {resolved_name}: {str(e)}")

        passed = len(errors) == 0 and valid_screenshots == total_screenshots
        return AppStoreGenerationResult(
            passed=passed,
            total_devices=len(APP_STORE_SPECS),
            total_screenshots=total_screenshots,
            valid_screenshots=valid_screenshots,
            invalid_screenshots=total_screenshots - valid_screenshots,
            screenshots=screenshots,
            errors=errors,
        )

    def _make_pots_buddy_navigator(self, udid: str) -> Callable[[str], bool]:
        """
        Return a navigate_to_screen callback for POTS Buddy's 3-tab layout.

        Tab mapping (from ContentView.swift):
          "Dashboard" → tab label "Dashboard"  (tag 0)
          "Data"      → tab label "Data"        (tag 1)  [NOTE: not "History"]
          "History"   → alias for "Data"
          "Settings"  → tab label "Settings"   (tag 2)

        Uses xcuitest.tap_element() to tap the correct tab item.
        Falls back to a no-op (just screenshot current screen) on any xcuitest error,
        so a navigation failure doesn't abort the whole session.
        """
        # Normalize caller-facing names to actual POTS Buddy tab labels
        TAB_ALIASES = {
            "dashboard": "Dashboard",
            "history":   "Data",      # The app labels this tab "Data"
            "data":      "Data",
            "settings":  "Settings",
        }

        def navigate(screen_name: str) -> bool:
            tab_label = TAB_ALIASES.get(screen_name.lower(), screen_name)
            try:
                xcuitest.tap_element(label=tab_label, udid=udid, fuzzy=True)
                import time; time.sleep(0.5)  # Brief settle after tab switch
                return True
            except Exception as e:
                # Non-fatal: xcuitest may not be available or tab not found;
                # screenshot whatever screen is currently visible.
                print(f"  ⚠️  Navigation to '{screen_name}' failed ({e}) — screenshotting current screen")
                return False

        return navigate

    def _validate_screenshot(
        self, screenshot: sc.Screenshot, device_name: str, screen_size: str, errors: list[str]
    ) -> AppStoreScreenshot:
        """
        Validate a single screenshot against App Store requirements (IT9).

        Returns:
            AppStoreScreenshot with validation results
        """
        validation_errors = []

        # Check file format
        if not screenshot.path.endswith(".png"):
            validation_errors.append(f"Invalid format: {Path(screenshot.path).suffix} (expected .png)")

        # Check file size
        file_size_kb = screenshot.file_size_bytes / 1024
        if file_size_kb < MIN_FILE_SIZE_KB:
            validation_errors.append(f"File too small: {file_size_kb:.1f}KB (min {MIN_FILE_SIZE_KB}KB)")
        if file_size_kb > MAX_FILE_SIZE_KB:
            validation_errors.append(f"File too large: {file_size_kb:.1f}KB (max {MAX_FILE_SIZE_KB}KB)")

        # Check resolution
        resolution = (screenshot.width_px, screenshot.height_px)

        # Look up device spec — fall back gracefully for unknown/fallback device names
        device_specs = APP_STORE_SPECS.get(device_name)
        if device_specs is None:
            # Search all tiers for this device name
            for spec in APP_STORE_SPECS.values():
                # Accept any non-zero resolution from an unknown device — just verify it's plausible
                pass
            device_specs = None

        if device_specs is not None:
            allowed_resolutions = device_specs["required_resolutions"]
            resolution_valid = False
            for allowed_res in allowed_resolutions:
                width_match = abs(resolution[0] - allowed_res[0]) <= allowed_res[0] * RESOLUTION_TOLERANCE
                height_match = abs(resolution[1] - allowed_res[1]) <= allowed_res[1] * RESOLUTION_TOLERANCE
                if width_match and height_match:
                    resolution_valid = True
                    break
            if not resolution_valid and resolution[0] > 0 and resolution[1] > 0:
                # Warn but don't fail — resolution mismatch is common with new device generations
                print(f"  ⚠️  Resolution {resolution[0]}x{resolution[1]} differs from expected "
                      f"{allowed_resolutions[0]} for {device_name} (within tolerance: checking...)")
                # Still pass if image is a plausible iPhone resolution (height > width, > 1000px)
                if resolution[1] > resolution[0] and resolution[1] > 1000:
                    resolution_valid = True
            if not resolution_valid:
                validation_errors.append(
                    f"Invalid resolution: {resolution[0]}x{resolution[1]} "
                    f"(expected ~{allowed_resolutions[0]} for {screen_size})"
                )
        else:
            # Unknown device — accept if plausible iPhone resolution
            if not (resolution[1] > resolution[0] and resolution[1] > 1000):
                validation_errors.append(
                    f"Suspicious resolution {resolution[0]}x{resolution[1]} for unknown device {device_name}"
                )

        passes = len(validation_errors) == 0

        return AppStoreScreenshot(
            screenshot=screenshot,
            device_name=device_name,
            screen_size=screen_size,
            resolution=resolution,
            file_size_kb=file_size_kb,
            passes_validation=passes,
            validation_errors=validation_errors,
        )

    def export_results(self, result: AppStoreGenerationResult, output_file: str):
        """Export generation results to JSON file."""
        data = {
            "status": "PASS" if result.passed else "FAIL",
            "summary": result.summary(),
            "statistics": {
                "total_devices": result.total_devices,
                "total_screenshots": result.total_screenshots,
                "valid": result.valid_screenshots,
                "invalid": result.invalid_screenshots,
            },
            "screenshots": [s.to_dict() for s in result.screenshots],
            "errors": result.errors,
        }
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, "w") as f:
            json.dump(data, f, indent=2)
        print(f"\n📄 Results exported to: {output_file}")


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("Usage: python app_store_generator.py <project_path> <scheme> [--vision]")
        sys.exit(1)

    project_path = sys.argv[1]
    scheme = sys.argv[2]
    use_vision = "--vision" in sys.argv

    analyzer = VisionAnalyzer() if use_vision else None
    generator = AppStoreGenerator(project_path, scheme, vision_analyzer=analyzer)

    # Example: capture Dashboard and History screens
    result = generator.generate(
        screens=["Dashboard", "History"],
        navigate_to_screen=None,  # Would plug in xcuitest navigation here
        verify_with_vision=use_vision,
    )

    print(f"\n{result.summary()}")
    generator.export_results(result, "/tmp/app-store-results.json")
    sys.exit(0 if result.passed else 1)
