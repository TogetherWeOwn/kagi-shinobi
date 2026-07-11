// Typed JSON response helpers. Errors follow a small stable shape:
//   { error: { code, message } }
// so clients can key off `code` without parsing prose.

export interface ErrorBody {
  error: { code: string; message: string };
}

export function jsonOk(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export function jsonError(status: number, code: string, message: string): Response {
  const body: ErrorBody = { error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
