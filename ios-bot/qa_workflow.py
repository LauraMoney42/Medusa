"""
IT10 + IT11 — QA Workflow Integration & Pass/Fail Reporting

IT10: Trigger iOS QA from Medusa Hub @mention.
      Parses: "@iOS Testing Bot appstore <path> <scheme> [--screens S1,S2] [--vision]"
              "@iOS Testing Bot analyze <screenshot_path> [--screen Dashboard]"

IT11: Report pass/fail results back to Hub as a structured [HUB-POST: ...] message.

Designed to be called from Medusa task management when iOS work is submitted.
"""

from __future__ import annotations

import json
import re
import sys
import subprocess
from datetime import datetime
from pathlib import Path
from dataclasses import asdict
from typing import Optional

import simulator as sim
import screenshot_capture as sc
from app_store_generator import AppStoreGenerator, AppStoreGenerationResult
from vision_analysis import VisionAnalyzer


# ── IT10: Hub @mention parser ───────────────────────────────────────────────────

def parse_hub_mention(text: str) -> Optional[dict]:
    """
    IT10: Parse a Hub message for iOS bot commands.

    Recognized patterns (case-insensitive, after @mention):
      appstore  <project_path> <scheme> [--screens A,B] [--vision]
      analyze   <screenshot_path> [--screen Name]
      screenshot                 [--screens A,B] [--vision]

    Returns a command dict or None if no recognized pattern found.
    """
    # Strip leading @mention (handles "iOS Testing Bot", "iOS Bot", etc.)
    clean = re.sub(r"@ios[\w\s-]*bot\s*", "", text, flags=re.IGNORECASE).strip()

    action_match = re.match(r"^(appstore|analyze|screenshot)\b", clean, re.IGNORECASE)
    if not action_match:
        return None

    action = action_match.group(1).lower()
    rest = clean[action_match.end():].strip()

    cmd: dict = {"action": action}

    if action == "appstore":
        parts = rest.split()
        if len(parts) < 2:
            return None
        cmd["project_path"] = parts[0]
        cmd["scheme"] = parts[1]
        remaining = " ".join(parts[2:])
        screens_m = re.search(r"--screens\s+([\w,\s]+?)(?:\s+--|$)", remaining)
        cmd["screens"] = [s.strip() for s in screens_m.group(1).split(",")] if screens_m else ["Dashboard", "History"]
        cmd["use_vision"] = "--vision" in remaining

    elif action == "analyze":
        path_m = re.match(r"(\S+)", rest)
        if not path_m:
            return None
        cmd["screenshot_path"] = path_m.group(1)
        screen_m = re.search(r"--screen\s+(\S+)", rest)
        cmd["screen_name"] = screen_m.group(1) if screen_m else "unknown"

    elif action == "screenshot":
        screens_m = re.search(r"--screens\s+([\w,\s]+?)(?:\s+--|$)", rest)
        cmd["screens"] = [s.strip() for s in screens_m.group(1).split(",")] if screens_m else ["Main"]
        cmd["use_vision"] = "--vision" in rest

    return cmd


class QAWorkflowReporter:
    """Reports iOS QA results to Medusa Hub and generates summary."""

    def __init__(self, hub_post_enabled: bool = True):
        """
        Initialize reporter.

        Args:
            hub_post_enabled: If True, posts results to Medusa Hub via HUB-POST.
                             If False, just logs to stdout.
        """
        self.hub_post_enabled = hub_post_enabled
        self._last_hub_post: str = ""  # IT11: last emitted hub post for chaining

    def report_generation_complete(
        self,
        result: AppStoreGenerationResult,
        task_name: str,
        assignee: str = "@QA/Testing",
        screenshot_urls: Optional[dict[str, str]] = None,
    ) -> str:
        """
        Generate and post QA report to Hub.

        Args:
            result: AppStoreGenerationResult from generator
            task_name: Name of the iOS task being verified (e.g., "Dashboard UI Refactor")
            assignee: Medusa bot/user to mention (default: @QA/Testing)
            screenshot_urls: Optional dict mapping screenshot paths to URLs (for Hub linking)

        Returns:
            Hub post message string
        """
        # Build summary — result.summary() already includes the emoji, so don't double-up
        status_emoji = "✅" if result.passed else "❌"
        summary_line = result.summary()

        # Device summary
        device_lines = []
        for device_name in set(s.device_name for s in result.screenshots):
            device_shots = [s for s in result.screenshots if s.device_name == device_name]
            device_passed = sum(1 for s in device_shots if s.passes_validation)
            device_total = len(device_shots)
            device_status = "✅" if device_passed == device_total else "⚠️"
            device_lines.append(f"  {device_status} {device_name}: {device_passed}/{device_total} screens valid")

        # Vision analysis summary (if included)
        vision_lines = []
        vision_results = [s for s in result.screenshots if s.vision_analysis]
        if vision_results:
            vision_passed = sum(1 for s in vision_results if s.vision_analysis.passed)
            vision_total = len(vision_results)
            vision_status = "✅" if vision_passed == vision_total else "⚠️"
            vision_lines.append(f"  {vision_status} Claude vision: {vision_passed}/{vision_total} passed")

        # Error summary (if any)
        error_lines = []
        if result.errors:
            error_lines.append("  ⚠️ **Errors:**")
            for error in result.errors[:5]:  # Limit to 5 errors in Hub post
                error_lines.append(f"    - {error}")
            if len(result.errors) > 5:
                error_lines.append(f"    - ... and {len(result.errors) - 5} more")

        # Build Hub message body (single logical message — no literal newlines in [HUB-POST:])
        # The Medusa HubPostDetector handles the full text including newlines.
        parts = [f"{assignee} {status_emoji} iOS QA: {task_name} — {summary_line}"]
        parts.extend(device_lines)
        if vision_lines:
            parts.extend(vision_lines)
        if error_lines:
            parts.extend(error_lines[:3])  # Keep post terse

        hub_body = " | ".join(p.strip() for p in parts if p.strip())
        hub_message = f"[HUB-POST: {hub_body}]"

        if self.hub_post_enabled:
            self._post_to_hub(hub_message)

        return hub_message

    def _post_to_hub(self, message: str):
        """Print [HUB-POST: ...] to stdout — Medusa router picks it up."""
        self._last_hub_post = message
        print(message, flush=True)

    def export_detailed_report(self, result: AppStoreGenerationResult, output_file: str):
        """Export detailed JSON report for archival."""
        report = {
            "timestamp": datetime.now().isoformat(),
            "status": "PASS" if result.passed else "FAIL",
            "summary": result.summary(),
            "statistics": {
                "total_devices": result.total_devices,
                "total_screenshots": result.total_screenshots,
                "valid": result.valid_screenshots,
                "invalid": result.invalid_screenshots,
            },
            "screenshots": [
                {
                    **asdict(s.screenshot),
                    "device": s.device_name,
                    "screen_size": s.screen_size,
                    "resolution": s.resolution,
                    "file_size_kb": s.file_size_kb,
                    "valid": s.passes_validation,
                    "validation_errors": s.validation_errors,
                    "vision_analysis": asdict(s.vision_analysis) if s.vision_analysis else None,
                }
                for s in result.screenshots
            ],
            "errors": result.errors,
        }
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, "w") as f:
            json.dump(report, f, indent=2)


def dispatch_hub_command(cmd: dict, reporter: Optional["QAWorkflowReporter"] = None) -> str:
    """
    IT10: Execute a parsed Hub command and return the Hub post string (IT11).

    Args:
        cmd: Parsed command dict from parse_hub_mention()
        reporter: Optional QAWorkflowReporter (creates one if None)

    Returns:
        Hub post string (already printed to stdout if reporter.hub_post_enabled)
    """
    if reporter is None:
        reporter = QAWorkflowReporter(hub_post_enabled=True)

    action = cmd.get("action")

    if action == "analyze":
        path = cmd.get("screenshot_path")
        if not path or not Path(path).exists():
            msg = f"[HUB-POST: ❌ iOS QA: analyze failed — screenshot not found: {path}]"
            print(msg, flush=True)
            return msg
        try:
            analyzer = VisionAnalyzer()
            result = analyzer.analyze_screenshot(
                path,
                device_name=cmd.get("device_name", "unknown"),
                screen_name=cmd.get("screen_name", "unknown"),
            )
            status = "✅ PASS" if result.passed else "❌ FAIL"
            msg = f"[HUB-POST: 📱 iOS QA analyze {status}: {result.summary} (confidence {result.confidence:.0%})]"
        except Exception as e:
            msg = f"[HUB-POST: ❌ iOS QA analyze failed: {str(e)[:120]}]"
        print(msg, flush=True)
        return msg

    elif action == "screenshot":
        try:
            booted = sim.get_booted()
            if not booted:
                msg = "[HUB-POST: ❌ iOS QA screenshot: no booted simulator found]"
                print(msg, flush=True)
                return msg
            screens = cmd.get("screens", ["Main"])
            session = sc.capture_screens(
                udid=booted.udid,
                device_name=booted.name,
                screen_names=screens,
                output_dir="/tmp/ios-bot-qa/screenshots",
            )
            shots = session.screenshots
            status = "✅ PASS" if session.all_valid else "❌ FAIL"
            detail = ", ".join(f"{s.screen_name} {s.width_px}×{s.height_px}" for s in shots)
            msg = f"[HUB-POST: 📱 iOS QA screenshot {status}: {len(shots)} captured on {booted.name} — {detail}]"
        except Exception as e:
            msg = f"[HUB-POST: ❌ iOS QA screenshot failed: {str(e)[:120]}]"
        print(msg, flush=True)
        return msg

    elif action == "appstore":
        # Delegate to full QA verification
        trigger = QAWorkflowTrigger()
        trigger.reporter = reporter
        result = trigger.run_ios_qa_verification(
            project_path=cmd.get("project_path", ""),
            scheme=cmd.get("scheme", ""),
            screens=cmd.get("screens", ["Dashboard", "History"]),
            task_name=f"{cmd.get('scheme', 'App')} App Store Screenshots",
            enable_vision=cmd.get("use_vision", False),
        )
        return reporter._last_hub_post

    msg = f"[HUB-POST: ❌ iOS QA: unknown action {action!r}]"
    print(msg, flush=True)
    return msg


class QAWorkflowTrigger:
    """Handles QA workflow triggers from Medusa Hub."""

    def __init__(self):
        self.reporter = QAWorkflowReporter(hub_post_enabled=True)
        self.generator = None

    def run_ios_qa_verification(
        self,
        project_path: str,
        scheme: str,
        screens: list[str],
        task_name: str = "iOS App",
        enable_vision: bool = True,
        device_names: Optional[list[str]] = None,
    ) -> AppStoreGenerationResult:
        """
        Execute iOS QA verification workflow.

        Called from Medusa when iOS work is submitted for QA.

        Args:
            project_path: Path to .xcodeproj
            scheme: Xcode scheme to build
            screens: List of screens to verify (e.g., ["Dashboard", "Settings"])
            task_name: Name of the task being verified
            enable_vision: Enable Claude vision verification
            device_names: Optional list of specific devices (default: all App Store devices)

        Returns:
            AppStoreGenerationResult with detailed status
        """
        print(f"🚀 Starting iOS QA verification for: {task_name}")
        print(f"📋 Project: {project_path}")
        print(f"📱 Screens: {', '.join(screens)}")
        if enable_vision:
            print(f"🧠 Claude vision verification: enabled")

        # Initialize generator with vision analyzer
        analyzer = VisionAnalyzer() if enable_vision else None
        self.generator = AppStoreGenerator(
            project_path,
            scheme,
            output_dir="/tmp/qa-verification-screenshots",
            vision_analyzer=analyzer,
        )

        # Run generation and verification
        result = self.generator.generate(screens, verify_with_vision=enable_vision)

        # Report results
        hub_message = self.reporter.report_generation_complete(
            result, task_name=task_name, assignee="@QA/Testing"
        )
        print(f"\n📤 Hub report posted:\n{hub_message}")

        # Export detailed report
        report_file = f"/tmp/qa-verification-{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        self.reporter.export_detailed_report(result, report_file)
        print(f"\n📄 Detailed report: {report_file}")

        return result


def main():
    """CLI entry point for iOS QA verification."""
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python qa_workflow.py hub \"<hub message text>\"         # dispatch Hub @mention")
        print("  python qa_workflow.py appstore <path> <scheme> [--screens S1,S2] [--vision]")
        print("  python qa_workflow.py analyze  <screenshot_path> [--screen Name]")
        print("  python qa_workflow.py screenshot [--screens S1,S2] [--vision]")
        sys.exit(1)

    if sys.argv[1] == "hub":
        # IT10: Parse a Hub @mention and dispatch
        if len(sys.argv) < 3:
            print("Usage: python qa_workflow.py hub \"<hub message text>\"")
            sys.exit(1)
        hub_text = " ".join(sys.argv[2:])
        cmd = parse_hub_mention(hub_text)
        if not cmd:
            print(f"[HUB-POST: ❌ iOS QA: could not parse command from: {hub_text[:80]}]")
            sys.exit(1)
        dispatch_hub_command(cmd)
        sys.exit(0)

    # Direct CLI invocation
    action = sys.argv[1].lower()
    args = sys.argv[2:]

    if action in ("appstore",):
        if len(args) < 2:
            print("Usage: python qa_workflow.py appstore <project_path> <scheme> [--screens S1,S2] [--vision]")
            sys.exit(1)
        project_path = args[0]
        scheme = args[1]
        screens_idx = next((i for i, a in enumerate(args) if a == "--screens"), None)
        screens = args[screens_idx + 1].split(",") if screens_idx is not None else ["Dashboard", "History"]
        enable_vision = "--vision" in args
        task_name = "iOS Verification"
        if "--task-name" in args:
            idx = args.index("--task-name")
            if idx + 1 < len(args):
                task_name = args[idx + 1]
        trigger = QAWorkflowTrigger()
        result = trigger.run_ios_qa_verification(project_path, scheme, screens, task_name, enable_vision)
        sys.exit(0 if result.passed else 1)

    elif action == "analyze":
        if not args:
            print("Usage: python qa_workflow.py analyze <screenshot_path> [--screen Name]")
            sys.exit(1)
        cmd = {"action": "analyze", "screenshot_path": args[0]}
        screen_idx = next((i for i, a in enumerate(args) if a == "--screen"), None)
        cmd["screen_name"] = args[screen_idx + 1] if screen_idx is not None else "unknown"
        post = dispatch_hub_command(cmd)
        sys.exit(0 if "✅" in post else 1)

    elif action == "screenshot":
        cmd = {"action": "screenshot"}
        screens_idx = next((i for i, a in enumerate(args) if a == "--screens"), None)
        cmd["screens"] = args[screens_idx + 1].split(",") if screens_idx is not None else ["Main"]
        cmd["use_vision"] = "--vision" in args
        post = dispatch_hub_command(cmd)
        sys.exit(0 if "✅" in post else 1)

    else:
        print(f"Unknown action: {action!r}")
        sys.exit(1)


if __name__ == "__main__":
    main()
