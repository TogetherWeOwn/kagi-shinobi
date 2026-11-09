// Pin the qualified worker-only artifact and prove the first migration does not
// refresh unrelated lock nodes. On later PRs, only the permanent artifact/graph
// invariants apply; this is not a blanket freeze on the rest of the repository.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface LockNode {
  version: string;
  integrity?: string;
}
interface Lock {
  packages: Record<string, LockNode>;
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as Lock;
const candidate = "1.5.0-rc.0";
const approved: Record<string, string> = {
  "@cloudflare/puppeteer": candidate,
  "devtools-protocol": "0.0.1581282",
  "mitt": "3.0.1",
  "rxjs": "7.8.2",
  "parsel-js": "1.2.2",
  "typed-query-selector": "2.12.3",
  "urlpattern-polyfill": "10.1.0",
  "@types/debug": "4.1.13",
  "@types/ms": "2.1.0",
  "@types/node": "18.19.130",
  "undici-types": "5.26.5",
};
const forbidden = ["@puppeteer/browsers", "extract-zip", "basic-ftp", "get-uri", "proxy-agent"];
const orphaned = new Set([
  "@puppeteer/browsers", "@tootallnate/quickjs-emscripten", "@types/yauzl",
  "ansi-regex", "ansi-styles", "ast-types", "b4a", "bare-events", "bare-fs",
  "bare-path", "bare-stream", "bare-url", "base64-js", "basic-ftp", "buffer",
  "buffer-crc32", "cliui", "color-convert", "color-name", "data-uri-to-buffer",
  "degenerator", "emoji-regex", "end-of-stream", "escodegen", "esprima",
  "estraverse", "esutils", "events-universal", "extract-zip", "fast-fifo",
  "fd-slicer", "get-caller-file", "get-stream", "get-uri", "http-proxy-agent",
  "ieee754", "is-fullwidth-code-point", "netmask", "pac-proxy-agent", "pac-resolver",
  "pend", "progress", "proxy-agent", "proxy-from-env", "pump", "require-directory",
  "smart-buffer", "socks", "socks-proxy-agent", "source-map", "streamx",
  "string-width", "strip-ansi", "tar-fs", "tar-stream", "teex", "text-decoder",
  "through", "unbzip2-stream", "wrap-ansi", "ws", "y18n", "yargs", "yauzl",
]);

function packageName(path: string): string {
  return path.split("node_modules/").at(-1)!;
}

function pins(input: Lock): Set<string> {
  return new Set(Object.entries(input.packages).filter(([path]) => path).map(
    ([path, node]) => `${packageName(path)}@${node.version}:${node.integrity}`,
  ));
}

function runtimeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? runtimeFiles(path) : path.endsWith(".js") ? [path] : [];
  });
}

describe("qualified worker-only browser dependencies", () => {
  it("pins the exact published artifact rather than a moving prerelease tag", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.dependencies["@cloudflare/puppeteer"]).toBe(candidate);
    expect(lock.packages["node_modules/@cloudflare/puppeteer"]).toMatchObject({
      version: candidate,
      integrity: "sha512-VuLJTyiOfZuGgYdOZXb8YcP+wjs1JVCPRAoeq+W7TzqTRI1vq0Zb2asvlIqf4PGmj1f/9E6kc+jO+fyaNBZgGA==",
    });
  });

  it("contains no old installer/archive/FTP package at any lock location", () => {
    const names = Object.keys(lock.packages).map(packageName);
    for (const name of forbidden) expect(names).not.toContain(name);
  });

  it("keeps the native age and lifecycle refusal policy effective", () => {
    const config = readFileSync(".npmrc", "utf8");
    expect(config).toMatch(/^min-release-age=3$/m);
    expect(config).toMatch(/^ignore-scripts=true$/m);
  });

  it("contains no installer imports or named bundled copies in the installed runtime JS", () => {
    const root = "node_modules/@cloudflare/puppeteer";
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.version).toBe(candidate);
    expect(manifest.exports["."].default).toBe("./lib/index.js");
    const files = runtimeFiles(join(root, "lib"));
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const name of forbidden) expect(source, `${file}: ${name}`).not.toContain(name);
    }
    // This is a package-content regression check, not proof against arbitrary
    // unbranded copied code or a substitute for npm audit and transport tests.
  });

  it("preserves every unrelated version and integrity during the initial migration", () => {
    const base = process.env.BROWSER_DEPENDENCY_BASE;
    // CI supplies its exact PR base (and fetches history). Outside PR CI the
    // artifact tests above still run, without inventing a comparison baseline.
    if (!base || /^0+$/.test(base)) return;
    const before = JSON.parse(execFileSync("git", ["show", `${base}:package-lock.json`], {
      encoding: "utf8",
    })) as Lock;
    if (before.packages["node_modules/@cloudflare/puppeteer"]?.version !== "1.4.0") return;
    const oldPins = pins(before);
    const newPins = pins(lock);
    for (const [path, node] of Object.entries(lock.packages)) {
      if (!path) continue;
      const name = packageName(path);
      if (!oldPins.has(`${name}@${node.version}:${node.integrity}`)) {
        expect(node.version, `unapproved new pin: ${path}`).toBe(approved[name]);
      }
    }
    for (const [path, node] of Object.entries(before.packages)) {
      if (!path) continue;
      const name = packageName(path);
      if (newPins.has(`${name}@${node.version}:${node.integrity}`)) continue;
      // lru-cache@7 is private to the old proxy-agent; all other lru-cache
      // versions, shared debug/tslib and platform-optional pins must survive.
      const removed = orphaned.has(name) || path === "node_modules/proxy-agent/node_modules/lru-cache";
      const replaced = name === "@cloudflare/puppeteer" || name === "devtools-protocol";
      expect(removed || replaced, `lost held pin: ${path}@${node.version}`).toBe(true);
    }
  });
});
