import assert from "node:assert/strict";
import test from "node:test";

import { JiraApiError, JiraClient, JiraRateLimitError } from "../dist/jira/client.js";

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

test("jira client: Basic 认证头与字段查询", async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse({ id: "1", key: "AOS-1", fields: {} }));
  const client = new JiraClient({
    siteUrl: "https://aos-test.atlassian.net",
    email: "qa@example.com",
    apiToken: "token_abc",
    fetchImpl,
    env: {}
  });
  await client.getIssue("AOS-1", ["summary", "status"]);
  const call = fetchImpl.calls[0];
  assert.equal(
    call.url,
    "https://aos-test.atlassian.net/rest/api/3/issue/AOS-1?fields=summary,status"
  );
  assert.equal(call.init.method, "GET");
  assert.equal(
    call.init.headers.Authorization,
    `Basic ${Buffer.from("qa@example.com:token_abc").toString("base64")}`
  );
  assert.equal(call.init.headers.Accept, "application/json");
});

test("jira client: search/jql POST body 与分页透传", async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse({ issues: [], isLast: true }));
  const client = new JiraClient({
    siteUrl: "https://aos-test.atlassian.net",
    email: "search@example.com",
    apiToken: "token_search",
    fetchImpl,
    env: {}
  });
  await client.searchJql("project = AOS ORDER BY created DESC", {
    maxResults: 5,
    fields: ["summary"],
    nextPageToken: "tok-1"
  });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "https://aos-test.atlassian.net/rest/api/3/search/jql");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(JSON.parse(call.init.body), {
    jql: "project = AOS ORDER BY created DESC",
    maxResults: 5,
    fields: ["summary"],
    nextPageToken: "tok-1"
  });
});

test("jira client: 401 映射为可行动错误", async () => {
  const fetchImpl = fakeFetch(async () => new Response("Unauthorized", { status: 401 }));
  const client = new JiraClient({
    siteUrl: "https://aos-test.atlassian.net",
    email: "bad@example.com",
    apiToken: "token_bad",
    fetchImpl,
    env: {}
  });
  await assert.rejects(client.getIssue("AOS-1", []), (error) => {
    assert.ok(error instanceof JiraApiError);
    assert.equal(error.status, 401);
    assert.match(error.hint, /轮换/);
    return true;
  });
});

test("jira client: 429 长冷却 fail-fast 且按凭证记忆", async () => {
  const fetchImpl = fakeFetch(async () =>
    new Response("{}", {
      status: 429,
      headers: { "retry-after": "3600", "RateLimit-Reason": "jira-quota-tenant-based" }
    })
  );
  const client = new JiraClient({
    siteUrl: "https://aos-test.atlassian.net",
    email: "limit-long@example.com",
    apiToken: "token_limit_long",
    fetchImpl,
    env: { AOS_JIRA_RETRY_MAX_WAIT_MS: "0" }
  });
  await assert.rejects(client.getIssue("AOS-1", []), (error) => {
    assert.ok(error instanceof JiraRateLimitError);
    assert.equal(error.retryAfterSeconds, 3600);
    assert.equal(error.reason, "jira-quota-tenant-based");
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
  await assert.rejects(client.getIssue("AOS-2", []), (error) => error instanceof JiraRateLimitError);
  assert.equal(fetchImpl.calls.length, 1, "冷却期内不应再打 API");
});

test("jira client: 429 短等待重试一次", async () => {
  const sleeps = [];
  const fetchImpl = fakeFetch(async (_url, _init, count) => {
    if (count === 1) {
      return new Response("{}", { status: 429, headers: { "retry-after": "2" } });
    }
    return jsonResponse({ key: "AOS-3", fields: {} });
  });
  const client = new JiraClient({
    siteUrl: "https://aos-test.atlassian.net",
    email: "limit-short@example.com",
    apiToken: "token_limit_short",
    fetchImpl,
    env: { AOS_JIRA_RETRY_MAX_WAIT_MS: "5000" },
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });
  const result = await client.getIssue("AOS-3", []);
  assert.equal(result.key, "AOS-3");
  assert.deepEqual(sleeps, [2000]);
  assert.equal(fetchImpl.calls.length, 2);
});
