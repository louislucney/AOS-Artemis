import { z } from "zod";

import { jobStatus } from "../../jobs/async.js";
import type { NativeToolDefinition } from "./types.js";

export const JOBS_NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "aos_job_status",
    description:
      "查询异步工具任务（async:true 的 run_regression/verify_jira_issue/design_to_test）状态：running/passed/failed/error、起止时间、事件摘要、完整结果（落盘 .artemis/jobs/<jobId>.json）。",
    schema: z.object({
      jobId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._:-]+$/, "jobId 只能包含字母、数字、. _ : -")
        .describe("异步调用返回的 jobId")
    }),
    handler: (runtime, args) => jobStatus(runtime, String(args.jobId))
  }
];
