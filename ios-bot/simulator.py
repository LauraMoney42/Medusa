"""
IT4 — iOS Simulator lifecycle management via xcrun simctl.

Handles: list, boot, install, launch, terminate, screenshot, shutdown.
All operations target a specific simulator UDID or the currently booted device.
"""

from __future__ import annotations

import subprocess
import json
import time
from dataclasses import dataclass
from typing import Optional


@dataclass
class SimulatorDevice:
    name: str
    udid: str
    state: str          # "Booted", "Shutdown", etc.
    runtime: str        # e.g. "iOS 26.1"
    is_available: bool

    @property
    def is_booted(self) -> bool:
        return self.state == "Booted"


def list_devices(runtime_filter: str = "iOS") -> list:
    """Return all available simulator devices, optionally filtered by runtime."""
    result = subprocess.run(
        ["xcrun", "simctl", "list", "devices", "available", "--json"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"simctl list failed: {result.stderr.strip()}")

    data = json.loads(result.stdout)
    devices = []
    for runtime_key, devs in data.get("devices", {}).items():
        # runtime_key looks like "com.apple.CoreSimulator.SimRuntime.iOS-26-1"
        runtime_label = runtime_key.split("SimRuntime.")[-1].replace("-", " ").replace("iOS ", "iOS ")
        if runtime_filter and runtime_filter.lower() not in runtime_label.lower():
            continue
        for dev in devs:
            if not dev.get("isAvailable"):
                continue
            devices.append(SimulatorDevice(
                name=dev["name"],
                udid=dev["udid"],
                state=dev["state"],
                runtime=runtime_label,
                is_available=True,
            ))
    return devices


def get_booted() -> Optional[SimulatorDevice]:
    """Return the currently booted simulator, or None."""
    for dev in list_devices():
        if dev.is_booted:
            return dev
    return None


def boot(udid: str, wait_secs: float = 30.0) -> SimulatorDevice:
    """
    Boot a simulator by UDID, open Simulator.app, and wait for display initialization.

    Simulator.app must be open for screenshot capture to work — simctl alone
    boots the process but does not initialize the display renderer.

    Raises RuntimeError if boot times out or fails.
    """
    # Check if already booted
    for dev in list_devices():
        if dev.udid == udid and dev.is_booted:
            # Still open Simulator.app in case it was closed
            open_simulator_app()
            time.sleep(2.0)  # allow display to initialize
            return dev

    result = subprocess.run(
        ["xcrun", "simctl", "boot", udid],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        err = result.stderr.strip()
        # "already booted" is not an error
        if "already booted" not in err.lower():
            raise RuntimeError(f"simctl boot failed: {err}")

    # Open Simulator.app to initialize the display renderer (required for screenshots)
    open_simulator_app()

    # Wait for Booted state
    deadline = time.monotonic() + wait_secs
    while time.monotonic() < deadline:
        for dev in list_devices():
            if dev.udid == udid and dev.is_booted:
                # Extra wait for display to fully initialize
                time.sleep(5.0)
                return dev
        time.sleep(1.0)

    raise TimeoutError(f"Simulator {udid} did not reach Booted state within {wait_secs}s")


def open_simulator_app():
    """Open the macOS Simulator.app (brings simulator window to foreground)."""
    subprocess.run(["open", "-a", "Simulator"], check=True)


def install(udid: str, app_bundle_path: str):
    """Install a .app bundle on the simulator."""
    result = subprocess.run(
        ["xcrun", "simctl", "install", udid, app_bundle_path],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"simctl install failed: {result.stderr.strip()}")


def launch(udid: str, bundle_id: str, wait_secs: float = 5.0):
    """Launch an app by bundle ID and wait briefly for it to start."""
    result = subprocess.run(
        ["xcrun", "simctl", "launch", udid, bundle_id],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"simctl launch failed: {result.stderr.strip()}")
    time.sleep(wait_secs)


def terminate(udid: str, bundle_id: str):
    """Terminate a running app (no-op if not running)."""
    subprocess.run(
        ["xcrun", "simctl", "terminate", udid, bundle_id],
        capture_output=True,
        text=True,
    )


def screenshot(udid: str, output_path: str) -> str:
    """
    Capture a PNG screenshot of the simulator screen.

    Returns output_path on success. Raises RuntimeError on failure.
    """
    result = subprocess.run(
        ["xcrun", "simctl", "io", udid, "screenshot", output_path],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"simctl screenshot failed: {result.stderr.strip()}")
    return output_path


def shutdown(udid: str):
    """Shutdown a simulator (no-op if already shut down)."""
    subprocess.run(
        ["xcrun", "simctl", "shutdown", udid],
        capture_output=True,
        text=True,
    )


def find_device(name: str) -> Optional[SimulatorDevice]:
    """Find a simulator by name (case-insensitive, first match)."""
    name_lower = name.lower()
    for dev in list_devices():
        if name_lower in dev.name.lower():
            return dev
    return None


if __name__ == "__main__":
    import os

    print("IT4 — Simulator lifecycle verification")
    print()

    # List available devices
    devices = list_devices()
    print(f"Available iOS simulators ({len(devices)}):")
    for d in devices:
        status = "🟢 Booted" if d.is_booted else "⚫ Shutdown"
        print(f"  {status}  {d.name} ({d.udid[:8]}...)  [{d.runtime}]")

    # Use already-booted sim or boot iPhone 17 Pro Max
    booted = get_booted()
    if booted:
        print(f"\nUsing already-booted simulator: {booted.name}")
        open_simulator_app()
        time.sleep(3.0)  # ensure display is initialized for screenshots
        target = booted
    else:
        target = find_device("iPhone 17 Pro Max")
        if not target:
            target = devices[0]
        print(f"\nBooting {target.name}...")
        target = boot(target.udid)
        print(f"  ✅ Booted: {target.name}")

    # Capture a screenshot
    shot_path = "/tmp/ios_bot_it4_verify.png"
    print(f"\nCapturing screenshot → {shot_path}")
    screenshot(target.udid, shot_path)
    size = os.path.getsize(shot_path)
    print(f"  ✅ Screenshot: {size:,} bytes")

    print("\nIT4 verification complete. Simulator lifecycle working.")
