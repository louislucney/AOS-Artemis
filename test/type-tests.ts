import { type RunnerConfig, type RunnerToken, parseRunnerConfig } from "../src/runner/config.js";

const config: RunnerConfig = {
  centerUrl: new URL("http://center.example:8765"),
  token: "runner-token-0123456789" as RunnerToken,
  hostId: "win-runner-01" as RunnerConfig["hostId"]
};

const withProject: RunnerConfig = {
  centerUrl: new URL("http://center.example:8765"),
  token: "runner-token-0123456789" as RunnerToken,
  hostId: "win-runner-01" as RunnerConfig["hostId"],
  // @ts-expect-error runner config must not carry a center project path
  centerProjectRoot: "/Users/louis/Documents/AOS/ESSO-GU"
};

// @ts-expect-error a plain string is not a branded RunnerToken
const plainToken: RunnerToken = "plain-string";

// @ts-expect-error runner config requires a token
const missingToken: RunnerConfig = {
  centerUrl: new URL("http://center.example:8765"),
  hostId: "win-runner-01" as RunnerConfig["hostId"]
};

const parsed = parseRunnerConfig({});
if (parsed.ok) {
  // @ts-expect-error a parsed runner config has no center project path
  parsed.config.centerProjectRoot;
}

void config;
void withProject;
void plainToken;
void missingToken;
