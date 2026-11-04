#!/usr/bin/env python3
"""Throwaway Phase 0 spike: ARTEMIS driver/controller seam for iOS.

This does not modify ARTEMIS. It:
1. talks to the fake device RPC (spikes/ios-artemis/fake_device_rpc.mjs),
2. implements BaseDeviceDriver + a controller shim,
3. drives a login flow through the generic controller,
4. probes whether Artemis SDK Agent.init can start against an iOS device context.

Run:
  artemis/.venv/bin/python spikes/ios-artemis/spike_controller.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import types
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARTEMIS = REPO / "artemis"
if str(ARTEMIS) not in sys.path:
    sys.path.insert(0, str(ARTEMIS))

from artemis.drivers.base import (  # noqa: E402
    BaseDeviceDriver,
    KeyCode,
    ScreenData,
    SwipeDirection,
)
from third_party.mobile_use.controllers.types import ElementQuery  # noqa: E402
from third_party.mobile_use.controllers.unified_controller import (  # noqa: E402
    UnifiedMobileControllerBase,
)

RPC_URL = os.environ.get("SPIKE_RPC_URL", "http://127.0.0.1:15190/rpc")


class RpcError(RuntimeError):
    pass


class UnsupportedOnIosError(RuntimeError):
    pass


class RpcClient:
    def __init__(self, url: str):
        self.url = url
        self.next_id = 1
        self.calls: list[dict] = []

    def call(self, method: str, params: dict | None = None):
        request_id = self.next_id
        self.next_id += 1
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": f"spike-{request_id}",
                "method": method,
                "params": params or {},
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=body,
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
        self.calls.append({"method": method, "params": params or {}})
        if payload.get("error"):
            error = payload["error"]
            raise RpcError(f"{error.get('code')}: {error.get('message')}")
        return payload.get("result")


class IosRemoteDriver(BaseDeviceDriver):
    def __init__(self, client: RpcClient, udid: str):
        self.client = client
        self.udid = udid
        self.session_id: str | None = None
        self.info: dict | None = None
        self._screen: ScreenData | None = None

    @property
    def device_id(self) -> str:
        return self.udid

    @property
    def screen_size(self) -> tuple[int, int]:
        if self.info is None:
            return (600, 1200)
        return (int(self.info["widthPx"]), int(self.info["heightPx"]))

    @property
    def scale(self) -> float:
        if self.info is None:
            return 1.0
        return float(self.info.get("scale") or 1.0)

    async def connect(self) -> None:
        result = self.client.call("initialize", {"udid": self.udid})
        self.session_id = result["sessionId"]
        self.info = result["info"]

    async def disconnect(self) -> None:
        if self.session_id is not None:
            self.client.call("shutdown", {"sessionId": self.session_id})
            self.session_id = None

    def _session(self) -> dict:
        if self.session_id is None:
            raise RpcError("driver not connected")
        return {"sessionId": self.session_id}

    async def get_screen_data(self, skip_settling: bool = False) -> ScreenData:
        result = self.client.call(
            "screen",
            {
                **self._session(),
                "includeScreenshot": True,
                "includeSource": True,
            },
        )
        self._screen = ScreenData(
            screenshot_bytes=__import__("base64").b64decode(result["screenshotBase64"]),
            screenshot_base64=result["screenshotBase64"],
            ui_hierarchy_xml=result.get("hierarchyXml"),
            ui_elements=result.get("elements") or [],
            width=int(result["widthPx"]),
            height=int(result["heightPx"]),
            platform="ios",
        )
        return self._screen

    def _to_points(self, x: int, y: int) -> tuple[float, float]:
        scale = self.scale or 1.0
        return (x / scale, y / scale)

    async def tap(
        self,
        x: int,
        y: int,
        duration_ms: int = 100,
        times: int = 1,
        delay_ms: int = 100,
    ) -> bool:
        px, py = self._to_points(x, y)
        self.client.call(
            "tap",
            {
                **self._session(),
                "x": px,
                "y": py,
                "durationMs": duration_ms,
                "times": times,
            },
        )
        return True

    async def long_press(self, x: int, y: int, duration_ms: int = 1000) -> bool:
        px, py = self._to_points(x, y)
        self.client.call(
            "longPress",
            {**self._session(), "x": px, "y": py, "durationMs": duration_ms},
        )
        return True

    async def swipe(
        self,
        start_x: int,
        start_y: int,
        end_x: int,
        end_y: int,
        duration_ms: int = 800,
    ) -> bool:
        sx, sy = self._to_points(start_x, start_y)
        ex, ey = self._to_points(end_x, end_y)
        self.client.call(
            "swipe",
            {
                **self._session(),
                "x1": sx,
                "y1": sy,
                "x2": ex,
                "y2": ey,
                "durationMs": duration_ms,
            },
        )
        return True

    async def swipe_direction(
        self,
        direction: SwipeDirection | str,
        duration_ms: int = 800,
    ) -> bool:
        self.client.call(
            "swipeDirection",
            {
                **self._session(),
                "direction": str(getattr(direction, "value", direction)),
                "durationMs": duration_ms,
            },
        )
        return True

    async def input_text(self, text: str, clear_existing: bool = True) -> bool:
        self.client.call(
            "inputText",
            {**self._session(), "text": text, "clearExisting": clear_existing},
        )
        return True

    async def press_key(self, key: KeyCode | str | int) -> bool:
        name = str(getattr(key, "value", key))
        if name == "back":
            raise UnsupportedOnIosError("back")
        self.client.call("pressKey", {**self._session(), "key": name})
        return True

    async def launch_app(self, package_name: str) -> bool:
        self.client.call("launchApp", {**self._session(), "bundleId": package_name})
        return True

    async def stop_app(self, package_name: str) -> bool:
        self.client.call("terminateApp", {**self._session(), "bundleId": package_name})
        return True

    async def get_current_package(self) -> str | None:
        result = self.client.call("currentApp", self._session())
        return result.get("bundleId")

    async def execute_shell(self, command: str, timeout_seconds: float = 15.0) -> str:
        raise UnsupportedOnIosError("shell")

    async def start_video_recording(self, output_dir: Path | None = None) -> None:
        raise UnsupportedOnIosError("video")

    async def stop_video_recording(self) -> str | None:
        raise UnsupportedOnIosError("video")

    # The generic controller's open_url/erase_text use Android shell commands;
    # the iOS controller below overrides them with RPC calls.
    def open_url(self, url: str) -> None:
        self.client.call("openUrl", {**self._session(), "url": url})

    def erase_text(self, chars: int | None = None) -> None:
        self.client.call("eraseText", {**self._session(), "chars": chars or 0})


class IosMobileController(UnifiedMobileControllerBase):
    async def open_url(self, url: str) -> bool:
        await asyncio.to_thread(self.driver.open_url, url)
        return True

    async def erase_text(self, nb_chars: int | None = None) -> bool:
        await asyncio.to_thread(self.driver.erase_text, nb_chars)
        return True

    async def go_back(self) -> bool:
        raise UnsupportedOnIosError("back")


def fake_context():
    return types.SimpleNamespace(
        device=types.SimpleNamespace(
            device_id="FAKE-IOS-0001",
            mobile_platform="ios",
            device_width=600,
            device_height=1200,
        ),
        trace_id="spike-ios",
    )


async def run_controller_spike() -> dict:
    client = RpcClient(RPC_URL)
    driver = IosRemoteDriver(client, "FAKE-IOS-0001")
    await driver.connect()
    controller = IosMobileController(fake_context(), driver)

    first = await driver.get_screen_data()
    first_texts = [item.get("text") for item in first.ui_elements if item.get("text")]
    account = await driver.find_element(ElementQuery(text="账号"))
    login = await driver.find_element(ElementQuery(text="登录"))
    if account[1] is None or login[1] is None:
        raise RuntimeError(f"elements not found: account={account[2]} login={login[2]}")

    await driver.tap(account[1][0], account[1][1])
    await controller.type_text("spike-user")
    password = await driver.find_element(ElementQuery(text="密码"))
    await driver.tap(password[1][0], password[1][1])
    await controller.type_text("spike-pass")
    await controller.tap_element(text="登录", resource_id=None, index=0)
    second = await driver.get_screen_data()
    second_texts = [item.get("text") for item in second.ui_elements if item.get("text")]

    await controller.open_url("https://example.com/spike")
    back_supported = True
    try:
        await controller.go_back()
    except UnsupportedOnIosError:
        back_supported = False

    await driver.disconnect()
    return {
        "firstScreen": first_texts,
        "secondScreen": second_texts,
        "loginSuccess": "登录成功" in second_texts,
        "openUrl": True,
        "backSupported": back_supported,
        "rpcCalls": client.calls,
    }


async def probe_agent_init() -> dict:
    """Expected to expose the current Android-only Agent.init path."""
    os.environ.setdefault("ARTEMIS_FAKE_LLM", "1")
    try:
        from artemis.config import initialize_llm_config
        from artemis.context import DevicePlatform
        from artemis.sdk import Agent
        from artemis.sdk.builders import Builders
        from artemis.sdk.types import AgentProfile

        if not hasattr(DevicePlatform, "IOS"):
            return {
                "ok": False,
                "error": (
                    "DevicePlatform.IOS is missing in third_party/mobile_use; "
                    "Agent.init also forces DevicePlatform.ANDROID when device_id is passed"
                ),
            }
        profile = AgentProfile(name="default", llm_config=initialize_llm_config())
        config = (
            Builders.AgentConfig.with_default_profile(profile)
            .for_device(DevicePlatform.IOS, "FAKE-IOS-0001")
            .build()
        )
        agent = Agent(config=config)
        await agent.init(retry_count=1, retry_wait_seconds=1)
        await agent.clean(force=True)
        return {"ok": True, "error": None}
    except Exception as error:  # noqa: BLE001 - spike probe
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}


async def main() -> int:
    report = {
        "rpc": RPC_URL,
        "controller": None,
        "agentInit": None,
    }
    try:
        report["controller"] = await run_controller_spike()
    except Exception as error:  # noqa: BLE001 - spike probe
        report["controller"] = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    report["agentInit"] = await probe_agent_init()
    print(json.dumps(report, indent=2, ensure_ascii=False))
    controller_ok = isinstance(report["controller"], dict) and report["controller"].get(
        "loginSuccess"
    )
    return 0 if controller_ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
