"""
IT6 — XCUITest automation wrapper.

Provides high-level UI interaction primitives built on ios-simulator-mcp:
- tap_element(): find an element by accessibility label and tap it
- tap_xy(): tap at exact coordinates
- swipe(): scroll/swipe in a direction
- type_text(): input text into the focused field
- navigate_to(): sequence of actions to reach a named screen
- run_script(): execute a predefined interaction script with screenshot at each step

All interactions target the currently booted simulator via the MCPClient singleton.
"""

from __future__ import annotations

import json
import time
import re
from dataclasses import dataclass, field
from typing import Optional
from pathlib import Path

from mcp_client import get_client
from simulator import screenshot as simctl_screenshot, get_booted


# ── Data types ─────────────────────────────────────────────────────────────────

@dataclass
class UIElement:
    """Represents an accessibility element on screen."""
    label: str
    identifier: str
    element_type: str
    frame: dict        # {x, y, width, height}
    value: str = ""

    @property
    def center_x(self) -> float:
        return self.frame["x"] + self.frame["width"] / 2

    @property
    def center_y(self) -> float:
        return self.frame["y"] + self.frame["height"] / 2


@dataclass
class StepResult:
    """Result of executing one automation step."""
    action: str
    success: bool = False
    screenshot_path: Optional[str] = None
    error: Optional[str] = None
    detail: str = ""


@dataclass
class ScriptResult:
    """Result of running a full automation script."""
    script_name: str
    steps: list[StepResult] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return all(s.success for s in self.steps)

    @property
    def failed_steps(self) -> list[StepResult]:
        return [s for s in self.steps if not s.success]


# ── Screen description + element finding ───────────────────────────────────────

IDB_MISSING_MSG = (
    "idb_companion not found — UI interaction requires idb_companion at ~/Library/idb-companion/.\n"
    "Download from: https://github.com/facebook/idb/releases/latest (idb-companion.universal.tar.gz)\n"
    "Extract to ~/Library/idb-companion/ and run: pip3 install fb-idb"
)


def _is_idb_error(text: str) -> bool:
    """Check if a tool response indicates idb is missing or unavailable."""
    idb_error_markers = (
        "spawn idb ENOENT",
        "idb ENOENT",
        "FileNotFoundError",
        "idb_companion",  # any error mentioning companion path
    )
    return any(m in text for m in idb_error_markers) and "Error" in text


def describe_screen(udid: Optional[str] = None) -> list[UIElement]:
    """
    Return all accessibility elements on the current screen.
    Parses the JSON response from ios-simulator-mcp's ui_describe_all.

    Returns empty list if idb is not installed (non-fatal — callers fall back
    to coordinate-based interaction). Raises RuntimeError for other failures.
    """
    client = get_client()
    args = {}
    if udid:
        args["udid"] = udid

    raw = client.call_tool("ui_describe_all", args, timeout=20.0)

    # idb not installed — return empty list so callers can still work with xy-taps
    if _is_idb_error(raw):
        return []

    # The tool returns a JSON string describing the accessibility tree
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # Plain-text or other format — return empty list
        return []

    return _parse_elements(data)


def _parse_elements(data: object, elements: Optional[list] = None) -> list[UIElement]:
    """Recursively walk the accessibility tree and collect leaf elements."""
    if elements is None:
        elements = []

    if isinstance(data, list):
        for item in data:
            _parse_elements(item, elements)
    elif isinstance(data, dict):
        # Extract element if it has a frame (i.e. it's a visible element)
        frame = data.get("frame") or data.get("rect")
        if frame:
            label = data.get("label") or data.get("accessibilityLabel") or ""
            identifier = data.get("identifier") or data.get("accessibilityIdentifier") or ""
            element_type = data.get("elementType") or data.get("type") or "Unknown"
            value = data.get("value") or ""
            if label or identifier:
                elements.append(UIElement(
                    label=label,
                    identifier=identifier,
                    element_type=element_type,
                    frame=_normalize_frame(frame),
                    value=str(value),
                ))
        # Recurse into children
        for key in ("children", "elements", "subtree"):
            if key in data:
                _parse_elements(data[key], elements)

    return elements


def _normalize_frame(frame: dict) -> dict:
    """Normalize frame dict to always have x, y, width, height keys."""
    if "x" in frame:
        return {
            "x": float(frame.get("x", 0)),
            "y": float(frame.get("y", 0)),
            "width": float(frame.get("width", 0)),
            "height": float(frame.get("height", 0)),
        }
    # Some versions use origin/size nesting
    origin = frame.get("origin", {})
    size = frame.get("size", {})
    return {
        "x": float(origin.get("x", 0)),
        "y": float(origin.get("y", 0)),
        "width": float(size.get("width", 0)),
        "height": float(size.get("height", 0)),
    }


def find_element(
    label: Optional[str] = None,
    identifier: Optional[str] = None,
    element_type: Optional[str] = None,
    udid: Optional[str] = None,
    fuzzy: bool = True,
) -> Optional[UIElement]:
    """
    Find the first element matching the given criteria.
    Returns None if no match found.
    fuzzy=True allows case-insensitive partial label matching.
    """
    elements = describe_screen(udid)

    for el in elements:
        if label:
            if fuzzy:
                if label.lower() not in el.label.lower():
                    continue
            else:
                if el.label != label:
                    continue
        if identifier:
            if el.identifier != identifier:
                continue
        if element_type:
            if el.element_type.lower() != element_type.lower():
                continue
        return el

    return None


# ── Interaction primitives ──────────────────────────────────────────────────────

def tap_xy(x: float, y: float, udid: Optional[str] = None, duration: float = 0.1) -> None:
    """Tap at exact coordinates. Requires idb-companion to be installed."""
    client = get_client()
    # ios-simulator-mcp expects duration as a string
    args: dict = {"x": x, "y": y, "duration": str(duration)}
    if udid:
        args["udid"] = udid
    result = client.call_tool("ui_tap", args, timeout=10.0)
    if _is_idb_error(result):
        raise RuntimeError(IDB_MISSING_MSG)


def tap_element(
    label: Optional[str] = None,
    identifier: Optional[str] = None,
    udid: Optional[str] = None,
    fuzzy: bool = True,
) -> UIElement:
    """
    Find an element by label/identifier and tap its center.
    Raises ValueError if element is not found.
    """
    el = find_element(label=label, identifier=identifier, udid=udid, fuzzy=fuzzy)
    if el is None:
        desc = label or identifier or "(unknown)"
        raise ValueError(f"Element not found: {desc!r}")
    tap_xy(el.center_x, el.center_y, udid=udid)
    return el


def swipe(
    direction: str,
    distance: float = 300.0,
    udid: Optional[str] = None,
    duration: float = 0.5,
    start_x: Optional[float] = None,
    start_y: Optional[float] = None,
) -> None:
    """
    Swipe in a direction: "up", "down", "left", "right".
    Uses the center of the screen as start point unless overridden.
    distance controls how far (in points) the swipe travels.
    """
    # Default start at screen center (reasonable for most apps)
    sx = start_x if start_x is not None else 195.0
    sy = start_y if start_y is not None else 422.0

    direction = direction.lower()
    if direction == "up":
        ex, ey = sx, sy - distance
    elif direction == "down":
        ex, ey = sx, sy + distance
    elif direction == "left":
        ex, ey = sx - distance, sy
    elif direction == "right":
        ex, ey = sx + distance, sy
    else:
        raise ValueError(f"Unknown swipe direction: {direction!r}. Use up/down/left/right.")

    client = get_client()
    # ios-simulator-mcp expects duration as a string (e.g. "0.5"), not a float
    args: dict = {
        "x_start": sx,
        "y_start": sy,
        "x_end": ex,
        "y_end": ey,
        "duration": str(duration),
    }
    if udid:
        args["udid"] = udid
    result = client.call_tool("ui_swipe", args, timeout=15.0)
    if _is_idb_error(result):
        raise RuntimeError(IDB_MISSING_MSG)


def type_text(text: str, udid: Optional[str] = None) -> None:
    """Type text into the currently focused text field. Requires idb-companion."""
    client = get_client()
    args: dict = {"text": text}
    if udid:
        args["udid"] = udid
    result = client.call_tool("ui_type", args, timeout=15.0)
    if _is_idb_error(result):
        raise RuntimeError(IDB_MISSING_MSG)


def wait(seconds: float) -> None:
    """Pause execution to let animations settle or screens load."""
    time.sleep(seconds)


# ── Screenshot helpers ──────────────────────────────────────────────────────────

def capture_step_screenshot(
    step_name: str,
    output_dir: str = "/tmp/ios_bot_steps",
    udid: Optional[str] = None,
) -> str:
    """
    Capture a screenshot for a script step.
    Filename: {step_name}_{timestamp}.png
    Returns the saved file path.
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", step_name)
    timestamp = int(time.time() * 1000)
    path = str(Path(output_dir) / f"{safe_name}_{timestamp}.png")

    booted = get_booted()
    target_udid = udid or (booted.udid if booted else "booted")
    simctl_screenshot(target_udid, path)
    return path


# ── Script execution engine ─────────────────────────────────────────────────────

# A script step is a dict with an "action" key and action-specific fields.
# Supported actions:
#   tap_label:   {"action": "tap_label", "label": str, "fuzzy": bool}
#   tap_id:      {"action": "tap_id", "identifier": str}
#   tap_xy:      {"action": "tap_xy", "x": float, "y": float}
#   swipe:       {"action": "swipe", "direction": str, "distance": float}
#   type:        {"action": "type", "text": str}
#   wait:        {"action": "wait", "seconds": float}
#   screenshot:  {"action": "screenshot", "name": str}
#   assert_text: {"action": "assert_text", "text": str} — fail if text not on screen

def run_script(
    script_name: str,
    steps: list[dict],
    output_dir: str = "/tmp/ios_bot_steps",
    udid: Optional[str] = None,
    screenshot_every_step: bool = False,
) -> ScriptResult:
    """
    Execute a sequence of UI interaction steps.

    Args:
        script_name: Human-readable name for reporting.
        steps: List of step dicts (see action types above).
        output_dir: Where to save screenshots.
        udid: Target simulator UDID. Defaults to the booted simulator.
        screenshot_every_step: If True, capture a screenshot after every step.

    Returns:
        ScriptResult with per-step outcomes.
    """
    result = ScriptResult(script_name=script_name)
    booted = get_booted()
    effective_udid = udid or (booted.udid if booted else None)

    for i, step in enumerate(steps):
        action = step.get("action", "unknown")
        step_label = step.get("name") or f"step_{i+1}_{action}"
        step_result = StepResult(action=f"{i+1}. {action}")

        try:
            if action == "tap_label":
                el = tap_element(
                    label=step["label"],
                    udid=effective_udid,
                    fuzzy=step.get("fuzzy", True),
                )
                step_result.detail = f"Tapped '{el.label}' at ({el.center_x:.0f}, {el.center_y:.0f})"

            elif action == "tap_id":
                el = tap_element(identifier=step["identifier"], udid=effective_udid)
                step_result.detail = f"Tapped id='{el.identifier}' at ({el.center_x:.0f}, {el.center_y:.0f})"

            elif action == "tap_xy":
                tap_xy(step["x"], step["y"], udid=effective_udid)
                step_result.detail = f"Tapped ({step['x']}, {step['y']})"

            elif action == "swipe":
                swipe(
                    direction=step["direction"],
                    distance=step.get("distance", 300.0),
                    udid=effective_udid,
                    duration=step.get("duration", 0.5),
                    start_x=step.get("start_x"),
                    start_y=step.get("start_y"),
                )
                step_result.detail = f"Swiped {step['direction']} {step.get('distance', 300):.0f}pt"

            elif action == "type":
                type_text(step["text"], udid=effective_udid)
                step_result.detail = f"Typed: {step['text']!r}"

            elif action == "wait":
                secs = step.get("seconds", 1.0)
                wait(secs)
                step_result.detail = f"Waited {secs}s"

            elif action == "screenshot":
                snap_name = step.get("name", step_label)
                path = capture_step_screenshot(snap_name, output_dir, effective_udid)
                step_result.screenshot_path = path
                step_result.detail = f"Screenshot: {path}"

            elif action == "assert_text":
                expected = step["text"]
                # Use accessibility tree to check for the text
                elements = describe_screen(effective_udid)
                labels = [el.label.lower() for el in elements]
                values = [el.value.lower() for el in elements]
                found = any(expected.lower() in t for t in labels + values)
                if not found:
                    raise AssertionError(f"Text not found on screen: {expected!r}")
                step_result.detail = f"Found text: {expected!r}"

            else:
                raise ValueError(f"Unknown action: {action!r}")

            step_result.success = True

            # Optional: screenshot after every successful step
            if screenshot_every_step and action != "screenshot":
                try:
                    path = capture_step_screenshot(step_label, output_dir, effective_udid)
                    step_result.screenshot_path = path
                except Exception:
                    pass  # Don't fail a step over a bonus screenshot

        except Exception as exc:
            step_result.success = False
            step_result.error = str(exc)
            # Still try to capture a screenshot for debugging
            try:
                path = capture_step_screenshot(f"FAIL_{step_label}", output_dir, effective_udid)
                step_result.screenshot_path = path
            except Exception:
                pass

        result.steps.append(step_result)

        # Stop on failure — don't continue into unknown app state
        if not step_result.success:
            break

    return result


# ── Predefined navigation scripts ───────────────────────────────────────────────

def navigate_to(
    screen_name: str,
    output_dir: str = "/tmp/ios_bot_steps",
    udid: Optional[str] = None,
) -> ScriptResult:
    """
    Navigate to a named screen using a predefined script.

    Built-in scripts:
    - "home": Dismiss any modal, go to app root
    - "settings": Open Settings tab
    - "back": Tap Back button

    For app-specific screens, define custom scripts and pass them to run_script() directly.
    """
    scripts: dict[str, list[dict]] = {
        "home": [
            {"action": "tap_label", "label": "Cancel", "fuzzy": False},
            {"action": "wait", "seconds": 0.3},
            {"action": "tap_label", "label": "Home", "fuzzy": True},
            {"action": "wait", "seconds": 0.5},
            {"action": "screenshot", "name": "home"},
        ],
        "settings": [
            {"action": "tap_label", "label": "Settings", "fuzzy": True},
            {"action": "wait", "seconds": 0.5},
            {"action": "screenshot", "name": "settings"},
        ],
        "back": [
            {"action": "tap_label", "label": "Back", "fuzzy": True},
            {"action": "wait", "seconds": 0.3},
            {"action": "screenshot", "name": "back"},
        ],
    }

    if screen_name not in scripts:
        raise ValueError(
            f"Unknown screen: {screen_name!r}. "
            f"Available: {list(scripts.keys())}. "
            "For custom screens, build a steps list and call run_script() directly."
        )

    return run_script(
        script_name=f"navigate_to_{screen_name}",
        steps=scripts[screen_name],
        output_dir=output_dir,
        udid=udid,
    )


# ── CLI self-test ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import os
    import sys

    print("IT6 — XCUITest automation wrapper verification")
    print()

    booted = get_booted()
    if not booted:
        print("❌ No booted simulator found. Boot one first (see simulator.py).")
        sys.exit(1)

    print(f"Target simulator: {booted.name} ({booted.udid[:8]}...)")
    print()

    # --- Step 1: Describe current screen ---
    print("Step 1: Describe screen accessibility elements")
    elements = describe_screen(booted.udid)
    print(f"  Found {len(elements)} accessibility elements")
    for el in elements[:5]:
        print(f"    [{el.element_type}] {el.label!r} @ ({el.center_x:.0f}, {el.center_y:.0f})")
    if len(elements) > 5:
        print(f"    ... and {len(elements) - 5} more")
    print()

    # --- Step 2: Run full script including idb interactions ---
    print("Step 2: Run full interaction script (screenshot + swipe + screenshot)")
    test_steps: list[dict] = [
        {"action": "wait", "seconds": 1.0},
        {"action": "screenshot", "name": "it6_initial_state"},
        {"action": "swipe", "direction": "up", "distance": 80.0, "duration": 0.3},
        {"action": "wait", "seconds": 0.5},
        {"action": "screenshot", "name": "it6_after_swipe"},
        {"action": "swipe", "direction": "down", "distance": 80.0, "duration": 0.3},
        {"action": "wait", "seconds": 0.3},
        {"action": "screenshot", "name": "it6_restored"},
    ]

    result = run_script(
        script_name="IT6 Verification",
        steps=test_steps,
        output_dir="/tmp/ios_bot_it6",
        udid=booted.udid,
    )

    print(f"  Script: {result.script_name}")
    print(f"  Result: {'✅ PASS' if result.passed else '❌ FAIL'}")
    for step in result.steps:
        status = "✅" if step.success else "❌"
        shot = f" → {step.screenshot_path}" if step.screenshot_path else ""
        err = f" ERROR: {step.error}" if step.error else ""
        print(f"  {status} {step.action}: {step.detail}{shot}{err}")

    print()

    # --- Step 3: Verify screenshot files exist ---
    print("Step 3: Verify screenshot files")
    screenshots = [s.screenshot_path for s in result.steps if s.screenshot_path]
    for path in screenshots:
        if os.path.exists(path):
            size = os.path.getsize(path)
            print(f"  ✅ {path} ({size:,} bytes)")
        else:
            print(f"  ❌ {path} — NOT FOUND")

    print()
    overall = "✅ IT6 PASS" if result.passed else "❌ IT6 FAIL"
    print(f"{overall} — XCUITest automation wrapper functional.")
