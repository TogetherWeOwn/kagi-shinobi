// Errors thrown by the Kagi client. Distinguished so the token manager can
// decide whether to trigger a refresh.

export class KagiAuthError extends Error {
  constructor(msg = "Invalid or expired session token") {
    super(msg);
    this.name = "KagiAuthError";
  }
}

export class KagiUpstreamError extends Error {
  constructor(public status: number, public statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "KagiUpstreamError";
  }
}

export class KagiParseError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "KagiParseError";
  }
}
