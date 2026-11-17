export type RunnerControlErrorCode =
  | "not-found"
  | "forbidden"
  | "claim-lost"
  | "session-lost"
  | "instance-mismatch"
  | "invalid-state"
  | "gateway-port-conflict"
  | "data-lease-busy"
  | "data-lease-cooldown"
  | "data-lease-not-found"
  | "data-lease-already-released";

export class RunnerControlError extends Error {
  readonly code: RunnerControlErrorCode;
  readonly status: number;

  constructor(code: RunnerControlErrorCode, message: string) {
    super(message);
    this.name = "RunnerControlError";
    this.code = code;
    this.status = code === "forbidden" ? 403 : code === "not-found" ? 404 : 409;
  }
}
