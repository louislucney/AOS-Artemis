/** 用户可见品牌为 mobile-testing；AOS_* 仅作为兼容别名保留。 */
export function httpTokenFrom(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MOBILE_TESTING_HTTP_TOKEN ?? env.AOS_HTTP_TOKEN ?? "").trim();
}

export function runnerJobTokenFrom(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MOBILE_TESTING_RUNNER_JOB_TOKEN ?? env.AOS_RUNNER_JOB_TOKEN ?? "").trim();
}
