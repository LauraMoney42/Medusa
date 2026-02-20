"""
Lightweight MCP stdio client for ios-simulator-mcp.

Speaks the MCP JSON-RPC 2.0 protocol over subprocess stdin/stdout.
No SDK dependency — just subprocess + json.
"""

from __future__ import annotations

import json
import subprocess
import threading
import queue
import os
from pathlib import Path
from typing import Optional

NODE_BIN = "/opt/homebrew/opt/node@25/bin/node"
MCP_SERVER = str(Path(__file__).parent / "node_modules/ios-simulator-mcp/build/index.js")

# idb_companion lives in ~/Library/idb-companion/bin/ (installed from GitHub release).
# The idb Python client uses IDB_COMPANION_PATH to locate the native binary.
IDB_COMPANION_PATH = str(Path.home() / "Library/idb-companion/bin/idb_companion")
IDB_CLIENT_BIN_DIR = str(Path.home() / "Library/Python/3.9/bin")

def _mcp_env() -> dict:
    """Build the environment for the MCP server subprocess.
    Ensures idb_companion and idb CLI are on PATH so ui_tap/swipe/type work.
    """
    env = os.environ.copy()
    # Prepend idb binary directories to PATH
    extra = f"{IDB_CLIENT_BIN_DIR}:{Path(IDB_COMPANION_PATH).parent}"
    existing_path = env.get("PATH", "")
    if extra not in existing_path:
        env["PATH"] = f"{extra}:{existing_path}"
    # Point idb Python client to the companion binary
    env["IDB_COMPANION_PATH"] = IDB_COMPANION_PATH
    return env


class MCPClient:
    """Synchronous MCP client that communicates with a stdio MCP server."""

    def __init__(self):
        self._proc: Optional[subprocess.Popen] = None
        self._response_queue: queue.Queue = queue.Queue()
        self._reader_thread: Optional[threading.Thread] = None
        self._next_id = 1

    def connect(self) -> dict:
        """Start the MCP server process and initialize the session."""
        self._proc = subprocess.Popen(
            [NODE_BIN, MCP_SERVER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,  # line-buffered
            env=_mcp_env(),
        )

        # Background thread reads server responses and queues them
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()

        result = self._call("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "ios-bot", "version": "1.0"},
        })
        return result

    def _read_loop(self):
        """Read newline-delimited JSON responses from the server."""
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
                self._response_queue.put(msg)
            except json.JSONDecodeError:
                pass  # ignore non-JSON lines (e.g. server close message)

    def _send(self, msg: dict):
        """Write a JSON-RPC message to the server's stdin."""
        if self._proc is None or self._proc.poll() is not None:
            raise RuntimeError("MCP server is not running")
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()

    def _call(self, method: str, params: dict, timeout: float = 15.0) -> dict:
        """Send a request and wait for the matching response by id."""
        req_id = self._next_id
        self._next_id += 1
        self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})

        # Drain the queue looking for our response id
        pending = []
        import time
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            try:
                msg = self._response_queue.get(timeout=min(remaining, 1.0))
                if msg.get("id") == req_id:
                    # Put back anything we pulled off for other ids
                    for m in pending:
                        self._response_queue.put(m)
                    if "error" in msg:
                        raise RuntimeError(f"MCP error: {msg['error']}")
                    return msg.get("result", {})
                else:
                    pending.append(msg)
            except queue.Empty:
                continue

        for m in pending:
            self._response_queue.put(m)
        raise TimeoutError(f"No response for {method} (id={req_id}) within {timeout}s")

    def list_tools(self) -> list:
        """Return the list of tools the server exposes."""
        result = self._call("tools/list", {})
        return result.get("tools", [])

    def call_tool(self, name: str, args: dict = {}, timeout: float = 30.0) -> str:
        """Call a named tool and return its text content."""
        result = self._call("tools/call", {"name": name, "arguments": args}, timeout=timeout)
        content = result.get("content", [])
        parts = []
        for item in content:
            if item.get("type") == "text":
                parts.append(item["text"])
            elif item.get("type") == "image":
                parts.append(f"[image: {item.get('mimeType','?')} {len(item.get('data',''))} bytes base64]")
        return "\n".join(parts)

    def screenshot(self, output_path: str) -> str:
        """Capture a screenshot via simctl and save to output_path."""
        # Use simctl directly — it writes the file without base64 overhead
        result = subprocess.run(
            ["xcrun", "simctl", "io", "booted", "screenshot", output_path],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"simctl screenshot failed: {result.stderr.strip()}")
        return output_path

    def disconnect(self):
        """Terminate the MCP server process."""
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.stdin.close()
            except Exception:
                pass
            self._proc.terminate()
            self._proc.wait(timeout=5)


# Convenience singleton
_client: Optional[MCPClient] = None


def get_client() -> MCPClient:
    global _client
    if _client is None:
        _client = MCPClient()
        _client.connect()
    return _client


if __name__ == "__main__":
    print("Connecting to ios-simulator-mcp...")
    client = MCPClient()
    info = client.connect()
    print(f"Connected: {info}")

    tools = client.list_tools()
    print(f"\n{len(tools)} tools available:")
    for t in tools:
        print(f"  {t['name']}: {t.get('description', '')[:80]}")

    print("\nGetting booted simulator ID...")
    sim_id = client.call_tool("get_booted_sim_id")
    print(f"  Simulator: {sim_id}")

    print("\nCapturing screenshot via simctl...")
    path = "/tmp/ios_bot_it2_verify.png"
    client.screenshot(path)
    size = os.path.getsize(path)
    print(f"  Screenshot saved: {path} ({size:,} bytes)")

    client.disconnect()
    print("\nIT2 verification complete. All systems go.")
