#!/usr/bin/env node
/**
 * Throwaway Phase 0 fake device RPC for the iOS ARTEMIS spike.
 * It implements just enough of the proposed JSON-RPC contract to exercise
 * IosRemoteDriver + UnifiedMobileControllerBase without Appium or a device.
 */
import { createServer } from "node:http";
import { PNG } from "pngjs";

const PORT = Number(process.env.SPIKE_RPC_PORT ?? "15190");
const UDID = "FAKE-IOS-0001";
const BUNDLE = "com.example.spike";

function pngBase64(width, height) {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = 245;
    image.data[index + 1] = 245;
    image.data[index + 2] = 245;
    image.data[index + 3] = 255;
  }
  return PNG.sync.write(image).toString("base64");
}

const screenshot = pngBase64(600, 1200);

const state = {
  screen: "login",
  focused: null,
  values: { account: "", password: "" },
  actions: []
};

function bounds(x, y, w, h) {
  return {
    parsed_bounds: { left: x, top: y, right: x + w, bottom: y + h },
    bounds: `[${x},${y}][${x + w},${y + h}]`
  };
}

function elements() {
  const root = {
    type: "XCUIElementTypeApplication",
    text: "",
    value: "",
    resource_id: BUNDLE,
    ...bounds(0, 0, 600, 1200)
  };
  if (state.screen === "login") {
    return [
      root,
      {
        type: "XCUIElementTypeTextField",
        text: "账号",
        value: state.values.account,
        resource_id: "account",
        ...bounds(40, 400, 520, 80)
      },
      {
        type: "XCUIElementTypeSecureTextField",
        text: "密码",
        value: state.values.password,
        resource_id: "password",
        ...bounds(40, 520, 520, 80)
      },
      {
        type: "XCUIElementTypeButton",
        text: "登录",
        value: "",
        resource_id: "login",
        ...bounds(200, 800, 200, 80)
      }
    ];
  }
  return [
    root,
    {
      type: "XCUIElementTypeStaticText",
      text: "登录成功",
      value: "",
      resource_id: "success",
      ...bounds(100, 300, 400, 60)
    },
    {
      type: "XCUIElementTypeButton",
      text: "退出",
      value: "",
      resource_id: "logout",
      ...bounds(200, 800, 200, 80)
    }
  ];
}

function hierarchyXml() {
  const nodes = elements()
    .map(
      (element) =>
        `<node class="${element.type}" text="${element.text}" content-desc="${element.value}" ` +
        `resource-id="${element.resource_id}" bounds="${element.bounds}" enabled="true" visible="true" />`
    )
    .join("");
  return `<hierarchy rotation="0">${nodes}</hierarchy>`;
}

function observation() {
  return {
    widthPx: 600,
    heightPx: 1200,
    scale: 2,
    orientation: "portrait",
    bundleId: BUNDLE,
    elements: elements(),
    hierarchyXml: hierarchyXml(),
    screenshotBase64: screenshot,
    alerts: []
  };
}

function ok() {
  return { ok: true };
}

function handle(method, params) {
  state.actions.push({ method, params });
  switch (method) {
    case "initialize":
      return {
        sessionId: "spike-session",
        info: {
          udid: params.udid ?? UDID,
          model: "iPhone Spike",
          osVersion: "18.1",
          widthPx: 600,
          heightPx: 1200,
          scale: 2,
          orientation: "portrait",
          bundleId: BUNDLE,
          capabilities: {
            back: false,
            home: true,
            shell: false,
            systemLogs: "none",
            video: "none",
            alerts: true,
            appInstall: false,
            ocr: "fake"
          }
        }
      };
    case "screen":
      return observation();
    case "tap": {
      const x = Number(params.x);
      const y = Number(params.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("invalid coordinate");
      // RPC tap coordinates are logical points; element bounds above are pixels (scale=2).
      if (state.screen === "login" && y >= 200 && y < 240) state.focused = "account";
      else if (state.screen === "login" && y >= 260 && y < 300) state.focused = "password";
      else if (state.screen === "login" && y >= 400 && y < 440) {
        if (state.values.account && state.values.password) state.screen = "success";
        else throw new Error("login fields empty");
      } else if (state.screen === "success" && y >= 400 && y < 440) {
        state.screen = "login";
        state.focused = null;
        state.values = { account: "", password: "" };
      }
      return ok();
    }
    case "inputText": {
      if (state.focused === null) throw new Error("no focused field");
      state.values[state.focused] = String(params.text ?? "");
      return { ok: true, mode: "type" };
    }
    case "eraseText":
      if (state.focused !== null) state.values[state.focused] = "";
      return ok();
    case "swipe":
    case "swipeDirection":
    case "longPress":
    case "pressKey":
    case "launchApp":
    case "terminateApp":
    case "openUrl":
    case "alerts":
      return ok();
    case "currentApp":
      return { bundleId: BUNDLE };
    case "health":
      return { ok: true, appium: "fake", devices: [UDID] };
    case "shutdown":
      return ok();
    default:
      throw new Error(`unknown method ${method}`);
  }
}

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/rpc") {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: "bad-json" } }));
      return;
    }
    try {
      const result = handle(String(payload.method), payload.params ?? {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null, result }));
    } catch (error) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          error: { code: "internal", message: String(error?.message ?? error) }
        })
      );
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake-rpc] listening on 127.0.0.1:${PORT}`);
});

process.on("SIGTERM", () => {
  console.log(`[fake-rpc] actions=${JSON.stringify(state.actions)}`);
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log(`[fake-rpc] actions=${JSON.stringify(state.actions)}`);
  server.close(() => process.exit(0));
});
