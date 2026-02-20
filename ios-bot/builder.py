"""
IT3 — Build iOS projects via xcodebuild CLI.

Wraps xcodebuild for building and listing schemes.
Streams build output line by line; raises on failure.
"""

from __future__ import annotations

import subprocess
import re
from dataclasses import dataclass, field
from typing import Optional
from pathlib import Path


@dataclass
class BuildResult:
    success: bool
    scheme: str
    destination: str
    derived_data_path: str
    app_path: Optional[str] = None   # path to .app bundle if found
    error: Optional[str] = None
    output_lines: list = field(default_factory=list)


def list_schemes(project_path: str) -> list:
    """Return the list of schemes in an Xcode project."""
    result = subprocess.run(
        ["xcodebuild", "-project", project_path, "-list"],
        capture_output=True,
        text=True,
    )
    schemes = []
    in_schemes = False
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if stripped == "Schemes:":
            in_schemes = True
            continue
        if in_schemes:
            if not stripped:
                break
            schemes.append(stripped)
    return schemes


def detect_simulator_sdk_mismatch() -> Optional[str]:
    """
    Check if the Xcode SDK version matches the installed simulator runtime.
    Returns a warning string if there's a mismatch, None if OK.

    Common cause: Xcode updated its SDK (e.g. 26.2) but simulator runtime
    still on older version (e.g. 26.1). Fix: Xcode > Settings > Components >
    download the latest iOS simulator runtime.
    """
    import re as _re

    # Get installed SDK version
    sdk_result = subprocess.run(
        ["xcodebuild", "-showsdks"],
        capture_output=True, text=True
    )
    sdk_match = _re.search(r"iphonesimulator(\d+\.\d+)", sdk_result.stdout)
    sdk_version = sdk_match.group(1) if sdk_match else None

    # Get installed simulator runtime version
    runtime_result = subprocess.run(
        ["xcrun", "simctl", "list", "runtimes"],
        capture_output=True, text=True
    )
    runtime_match = _re.search(r"iOS (\d+\.\d+) \(", runtime_result.stdout)
    runtime_version = runtime_match.group(1) if runtime_match else None

    if sdk_version and runtime_version and sdk_version != runtime_version:
        return (
            f"SDK/runtime mismatch: Xcode SDK is iOS {sdk_version} but "
            f"installed simulator runtime is iOS {runtime_version}. "
            f"Fix: Xcode > Settings > Components > download iOS {sdk_version} Simulator Runtime."
        )
    return None


def build(
    project_path: str,
    scheme: str,
    destination: str = "platform=iOS Simulator,name=iPhone 17 Pro Max",
    configuration: str = "Debug",
    derived_data_path: str = "/tmp/ios-bot-derived-data",
    verbose: bool = False,
) -> BuildResult:
    """
    Build an Xcode scheme for a simulator destination.

    Returns a BuildResult with success flag and path to .app bundle.
    Raises RuntimeError on subprocess failure (not build failure — use result.success).
    """
    cmd = [
        "xcodebuild",
        "-project", project_path,
        "-scheme", scheme,
        "-configuration", configuration,
        "-destination", destination,
        "-derivedDataPath", derived_data_path,
        "build",
        "CODE_SIGN_IDENTITY=",        # disable code signing for simulator builds
        "CODE_SIGNING_REQUIRED=NO",
        "CODE_SIGNING_ALLOWED=NO",
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,  # merge stderr into stdout
        text=True,
        bufsize=1,
    )

    output_lines = []
    error_lines = []

    for line in proc.stdout:
        line = line.rstrip()
        output_lines.append(line)
        if verbose:
            print(line)
        # Capture error lines for diagnosis
        if re.search(r'\berror:', line, re.IGNORECASE):
            error_lines.append(line)

    proc.wait()
    success = proc.returncode == 0

    # Find the .app bundle in derived data
    app_path = None
    if success:
        derived = Path(derived_data_path)
        matches = list(derived.glob(f"Build/Products/{configuration}-iphonesimulator/{scheme}.app"))
        if matches:
            app_path = str(matches[0])
        else:
            # Broader search
            matches = list(derived.glob(f"**/{scheme}.app"))
            if matches:
                app_path = str(matches[0])

    error_summary = None
    if not success and error_lines:
        # Return the first few meaningful errors
        error_summary = "\n".join(error_lines[:5])

    return BuildResult(
        success=success,
        scheme=scheme,
        destination=destination,
        derived_data_path=derived_data_path,
        app_path=app_path,
        error=error_summary,
        output_lines=output_lines,
    )


if __name__ == "__main__":
    import sys

    PROJECT = os.path.expanduser("~/Documents/GIT/POTS Buddy/POTS Buddy.xcodeproj")

    print("IT3 — Listing schemes...")
    schemes = list_schemes(PROJECT)
    print(f"  Schemes: {schemes}")

    # Check for SDK/runtime mismatch before attempting build
    mismatch = detect_simulator_sdk_mismatch()
    if mismatch:
        print(f"\n⚠️  {mismatch}")
        print("  Build will likely fail until runtime is updated.")

    scheme = "POTS Buddy"
    print(f"\nBuilding scheme '{scheme}' for simulator...")
    print("  (This may take 1-3 minutes on first build)")

    result = build(PROJECT, scheme, verbose=False)

    if result.success:
        print(f"  ✅ Build succeeded")
        print(f"  App bundle: {result.app_path or 'not found in derived data'}")
    else:
        print(f"  ❌ Build failed")
        if result.error:
            print(f"  Errors:\n{result.error}")
        print(f"  Last 10 lines of output:")
        for line in result.output_lines[-10:]:
            print(f"    {line}")

    sys.exit(0 if result.success else 1)
