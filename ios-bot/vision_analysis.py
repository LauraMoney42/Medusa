"""
IT7 — Claude vision analysis module.

Analyzes screenshots using Claude's vision API to verify UI correctness,
detect layout issues, and provide structured pass/fail results.

Designed for both manual verification and automated QA workflows.
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

try:
    from anthropic import Anthropic
except ImportError:
    raise ImportError("Please install: pip install anthropic")


# Vision analysis result
@dataclass
class VisionAnalysisResult:
    """Structured result from Claude vision analysis."""
    screenshot_path: str
    device_name: str
    screen_name: str
    passed: bool
    confidence: float  # 0.0-1.0
    summary: str
    issues: list[str]  # Empty if passed
    positives: list[str]  # What looked good
    recommendations: list[str]  # Optional improvements
    raw_response: str  # Full Claude response for debugging

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dict."""
        return {
            "screenshot": Path(self.screenshot_path).name,
            "device": self.device_name,
            "screen": self.screen_name,
            "passed": self.passed,
            "confidence": self.confidence,
            "summary": self.summary,
            "issues": self.issues,
            "positives": self.positives,
            "recommendations": self.recommendations,
        }

    def __repr__(self) -> str:
        status = "✅ PASS" if self.passed else "❌ FAIL"
        return f"{status} [{self.device_name} / {self.screen_name}] {self.summary}"


class VisionAnalyzer:
    """Analyzes iOS screenshots using Claude vision API."""

    def __init__(self, api_key: Optional[str] = None):
        """Initialize Claude client. Uses ANTHROPIC_API_KEY env var if api_key not provided."""
        key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY not set. Please export it or pass api_key=...")
        self.client = Anthropic(api_key=key)
        self._prompt_template = self._default_analysis_prompt()

    def _default_analysis_prompt(self) -> str:
        """Default vision analysis prompt — can be overridden per app."""
        return """Analyze this iOS app screenshot and verify UI correctness.

Check for:
1. **Text clarity** — All text is readable, correct font size, proper contrast
2. **Layout alignment** — Elements properly aligned, no overlapping, good spacing
3. **Colors** — Expected color scheme applied, no placeholder colors
4. **Navigation** — Top bar/buttons/tabs visible and positioned correctly
5. **Content** — Expected data/content is displayed
6. **Responsive design** — Layout adapts well to screen size

Respond with JSON:
{
  "passed": true/false,
  "confidence": 0.0-1.0,
  "summary": "One-sentence assessment",
  "issues": ["issue1", "issue2"],
  "positives": ["good1", "good2"],
  "recommendations": ["optional improvement1"]
}

Be strict but fair. Minor spacing issues are OK. Missing content, poor contrast, or broken layout are failures."""

    def analyze_screenshot(
        self,
        screenshot_path: str,
        device_name: str = "unknown",
        screen_name: str = "unknown",
        custom_prompt: Optional[str] = None,
    ) -> VisionAnalysisResult:
        """
        Analyze a single screenshot using Claude vision.

        Args:
            screenshot_path: Path to .png screenshot
            device_name: Device type (e.g., "iPhone 17 Pro Max")
            screen_name: Screen/view name (e.g., "Dashboard", "Settings")
            custom_prompt: Optional custom analysis prompt (replaces default)

        Returns:
            VisionAnalysisResult with pass/fail status and details
        """
        # Read and encode image
        path = Path(screenshot_path)
        if not path.exists():
            raise FileNotFoundError(f"Screenshot not found: {screenshot_path}")
        if path.suffix.lower() != ".png":
            raise ValueError(f"Expected .png, got: {path.suffix}")

        with open(path, "rb") as f:
            image_data = base64.standard_b64encode(f.read()).decode("utf-8")

        # Send to Claude
        prompt = custom_prompt or self._prompt_template
        response = self.client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": image_data,
                            },
                        },
                        {
                            "type": "text",
                            "text": prompt,
                        },
                    ],
                }
            ],
        )

        # Parse response
        response_text = response.content[0].text
        return self._parse_response(
            response_text, screenshot_path, device_name, screen_name
        )

    def _parse_response(
        self, response_text: str, screenshot_path: str, device_name: str, screen_name: str
    ) -> VisionAnalysisResult:
        """Parse Claude's JSON response into VisionAnalysisResult."""
        try:
            # Extract JSON from response (Claude may add surrounding text)
            json_start = response_text.find("{")
            json_end = response_text.rfind("}") + 1
            if json_start < 0 or json_end <= json_start:
                raise ValueError("No JSON found in response")

            json_str = response_text[json_start:json_end]
            data = json.loads(json_str)

            return VisionAnalysisResult(
                screenshot_path=screenshot_path,
                device_name=device_name,
                screen_name=screen_name,
                passed=data.get("passed", False),
                confidence=float(data.get("confidence", 0.5)),
                summary=data.get("summary", "No summary"),
                issues=data.get("issues", []),
                positives=data.get("positives", []),
                recommendations=data.get("recommendations", []),
                raw_response=response_text,
            )
        except (json.JSONDecodeError, ValueError, AttributeError) as e:
            # Fallback if response parsing fails
            return VisionAnalysisResult(
                screenshot_path=screenshot_path,
                device_name=device_name,
                screen_name=screen_name,
                passed=False,
                confidence=0.0,
                summary=f"Parse error: {str(e)[:100]}",
                issues=[f"Failed to parse vision response: {str(e)}"],
                positives=[],
                recommendations=[],
                raw_response=response_text,
            )

    def analyze_screenshots(
        self,
        screenshot_paths: list[str],
        device_names: Optional[list[str]] = None,
        screen_names: Optional[list[str]] = None,
        custom_prompt: Optional[str] = None,
    ) -> list[VisionAnalysisResult]:
        """
        Analyze multiple screenshots.

        Args:
            screenshot_paths: List of .png paths
            device_names: Optional list of device names (default: "unknown")
            screen_names: Optional list of screen names (default: "unknown")
            custom_prompt: Optional custom analysis prompt

        Returns:
            List of VisionAnalysisResult objects
        """
        if device_names is None:
            device_names = ["unknown"] * len(screenshot_paths)
        if screen_names is None:
            screen_names = ["unknown"] * len(screenshot_paths)

        results = []
        for path, device, screen in zip(screenshot_paths, device_names, screen_names):
            try:
                result = self.analyze_screenshot(path, device, screen, custom_prompt)
                results.append(result)
            except Exception as e:
                # Log error but continue with next screenshot
                results.append(
                    VisionAnalysisResult(
                        screenshot_path=path,
                        device_name=device,
                        screen_name=screen,
                        passed=False,
                        confidence=0.0,
                        summary=f"Analysis failed: {str(e)[:100]}",
                        issues=[str(e)],
                        positives=[],
                        recommendations=[],
                        raw_response="",
                    )
                )
        return results

    def set_prompt_template(self, prompt: str):
        """Override the default analysis prompt."""
        self._prompt_template = prompt


if __name__ == "__main__":
    # Quick test
    import sys

    if len(sys.argv) < 2:
        print("Usage: python vision_analysis.py <screenshot_path> [device_name] [screen_name]")
        sys.exit(1)

    screenshot = sys.argv[1]
    device = sys.argv[2] if len(sys.argv) > 2 else "unknown"
    screen = sys.argv[3] if len(sys.argv) > 3 else "unknown"

    analyzer = VisionAnalyzer()
    result = analyzer.analyze_screenshot(screenshot, device, screen)
    print(result)
    print(json.dumps(result.to_dict(), indent=2))
