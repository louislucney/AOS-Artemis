import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { Runtime } from "../../runtime.js";

/** 原生工具定义（NATIVE_TOOLS 域文件共用，DESIGN §13.89）。 */
export interface NativeToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (
    runtime: Runtime,
    args: Record<string, unknown>
  ) => Promise<CallToolResult> | CallToolResult;
}
