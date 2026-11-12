// The published package, not a vi.mock: exercise its binding transport and CDP
// bootstrap in workerd. No real browser, Internet request or Kagi login occurs.
import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../../src/env";
import { afterEach, describe, expect, it, vi } from "vitest";

interface Command {
  id: number;
  method: string;
  sessionId?: string;
}

type Mode = "success" | "malformed" | "silent";

function cdpBinding(mode: Mode = "success") {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  const commands: Command[] = [];
  const unexpected: string[] = [];
  let firstCommand!: () => void;
  const received = new Promise<void>((resolve) => { firstCommand = resolve; });
  const send = (message: object) => server.send(JSON.stringify(message));
  server.addEventListener("message", (event) => {
    const command = JSON.parse(String(event.data)) as Command;
    commands.push(command);
    firstCommand();
    if (mode === "silent") return;
    const reply = (result: unknown) => send({
      id: command.id, sessionId: command.sessionId, result,
    });
    if (mode === "malformed") {
      reply({ browserContextIds: null });
      return;
    }
    switch (command.method) {
      case "Target.getBrowserContexts":
        reply({ browserContextIds: [] });
        break;
      case "Target.createTarget": {
        const targetInfo = {
          targetId: "page-1", type: "page", title: "", url: "about:blank",
          attached: true, canAccessOpener: false,
        };
        reply({ targetId: targetInfo.targetId });
        send({ method: "Target.targetCreated", params: { targetInfo } });
        send({ method: "Target.attachedToTarget", params: {
          sessionId: "page-session", targetInfo, waitingForDebugger: false,
        } });
        break;
      }
      case "Page.getFrameTree":
        reply({ frameTree: { frame: {
          id: "frame-1", loaderId: "loader-1", url: "about:blank",
          securityOrigin: "://", mimeType: "text/html",
        } } });
        break;
      case "Page.addScriptToEvaluateOnNewDocument":
        reply({ identifier: "script-1" });
        break;
      case "Page.createIsolatedWorld":
        reply({ executionContextId: 1 });
        break;
      case "Target.setDiscoverTargets":
      case "Target.setAutoAttach":
      case "Runtime.runIfWaitingForDebugger":
      case "Network.enable":
      case "Network.setCacheDisabled":
      case "Page.enable":
      case "Page.setLifecycleEventsEnabled":
      case "Runtime.enable":
      case "Performance.enable":
      case "Log.enable":
      case "Emulation.setDeviceMetricsOverride":
      case "Emulation.setTouchEmulationEnabled":
      case "Browser.close":
        reply({});
        break;
      default:
        unexpected.push(command.method);
        send({ id: command.id, sessionId: command.sessionId,
          error: { code: -32601, message: `Unexpected fixture command: ${command.method}` } });
    }
  });
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ sessionId: "contract-session" });
    return new Response(null, { status: 101, webSocket: pair[0] });
  });
  return {
    binding: { fetch } as unknown as NonNullable<Env["BROWSER"]>,
    fetch, commands, unexpected, received,
    close: () => { server.close(1000, "fixture cleanup"); },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("worker-only Puppeteer package contract", () => {
  it.each([
    [429, "no sessions available"],
    [500, "binding failed"],
    [200, "not JSON"],
  ] as const)("rejects an acquisition response %i / %s without upgrading", async (status, body) => {
    const fetch = vi.fn(async () => new Response(body, { status }));
    const binding = { fetch } as unknown as NonNullable<Env["BROWSER"]>;

    await expect(puppeteer.launch(binding)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://fake.host/v1/devtools/browser?", { method: "POST" });
  });

  it("rejects a failed WebSocket upgrade through the same binding", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ sessionId: "refused-session" }))
      .mockResolvedValueOnce(new Response("upgrade refused", { status: 503 }));

    await expect(puppeteer.launch({ fetch } as unknown as NonNullable<Env["BROWSER"]>))
      .rejects.toThrow(/Unable to connect.*503.*upgrade refused/);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe("https://fake.host/v1/devtools/browser/refused-session");
  });

  it("launches, bootstraps a page, and closes over the supplied binding", async () => {
    const fixture = cdpBinding();
    const browser = await puppeteer.launch(fixture.binding);
    try {
      const page = await browser.newPage();
      expect(page.url()).toBe("about:blank");
      expect(browser.connected).toBe(true);
      expect(fixture.fetch).toHaveBeenCalledTimes(2);
      expect(fixture.fetch).toHaveBeenNthCalledWith(2,
        "https://fake.host/v1/devtools/browser/contract-session", {
          headers: { Upgrade: "websocket", "cf-brapi-client": "@cloudflare/puppeteer@1.5.0-rc.0" },
        });
      expect(fixture.commands.map((c) => c.method)).toEqual(expect.arrayContaining([
        "Target.getBrowserContexts", "Target.createTarget", "Page.getFrameTree", "Runtime.enable",
      ]));
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await browser.close();
      fixture.close();
    }
    expect(fixture.commands.filter((c) => c.method === "Browser.close")).toHaveLength(1);
    expect(browser.connected).toBe(false);
  }, 5_000);

  it("rejects a malformed CDP bootstrap response", async () => {
    const fixture = cdpBinding("malformed");
    try {
      await expect(puppeteer.launch(fixture.binding)).rejects.toThrow(/Unable to connect/);
      expect(fixture.commands[0]?.method).toBe("Target.getBrowserContexts");
    } finally {
      fixture.close();
    }
  });

  it("times out a silent CDP peer instead of leaving bootstrap pending", async () => {
    vi.useFakeTimers();
    const fixture = cdpBinding("silent");
    // Attach the rejection assertion before advancing the package's timeout.
    const rejected = expect(puppeteer.launch(fixture.binding)).rejects.toThrow(/timed out/);
    try {
      await fixture.received;
      await vi.advanceTimersByTimeAsync(180_001);
      await rejected;
      expect(fixture.commands.map((c) => c.method)).toEqual(["Target.getBrowserContexts"]);
    } finally {
      fixture.close();
    }
  }, 5_000);
});
