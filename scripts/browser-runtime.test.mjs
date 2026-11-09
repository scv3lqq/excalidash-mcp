import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const digest = value => createHash("sha256").update(value).digest("hex");
const browserBase = "node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d";

test("browser image pins both stages, installs manifest Chromium and preserves non-root assets", async () => {
  const dockerfile = await read("Dockerfile.browser");
  assert.deepEqual([...dockerfile.matchAll(/^FROM (\S+) AS (\S+)$/gm)].map(match => match.slice(1)), [[browserBase, "build"], [browserBase, "runtime"]]);
  assert.match(dockerfile, /RUN npm run test:unit/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
  assert.match(dockerfile, /node node_modules\/playwright-core\/cli\.js install --with-deps --no-shell chromium/);
  assert.match(dockerfile, /COPY --from=build \/app\/dist \.\/dist/);
  assert.match(dockerfile, /COPY --from=build \/app\/assets \.\/assets/);
  assert.match(dockerfile, /COPY LICENSE LICENSE-MIT PROVENANCE\.md/);
  assert.match(dockerfile, /COPY runtime \.\/runtime/);
  assert.match(dockerfile, /COPY scripts\/browser-smoke\.mjs \.\/scripts\/browser-smoke\.mjs/);
  assert.match(dockerfile, /^USER node$/m);
  assert.doesNotMatch(dockerfile, /--no-sandbox|--disable.*sandbox|npx|@latest/);
  const pkg = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  assert.equal(pkg.dependencies["playwright-core"], "1.65.0");
  assert.equal(lock.packages["node_modules/playwright-core"].version, pkg.dependencies["playwright-core"]);
  assert.equal(pkg.dependencies["@excalidraw/excalidraw"], "0.18.1");
});

test("seccomp preserves the pinned default-deny profile and namespace allowlist", async () => {
  const raw = await read("runtime/seccomp.json");
  assert.equal(digest(raw), "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849");
  const profile = JSON.parse(raw);
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  const unconditional = profile.syscalls.filter(rule => rule.action === "SCMP_ACT_ALLOW" && !rule.args?.length && !Object.keys(rule.includes ?? {}).length);
  for (const name of ["clone", "setns", "unshare"]) assert.ok(unconditional.some(rule => rule.names.includes(name)), name);
  for (const name of ["mount", "bpf", "reboot", "init_module"]) assert.ok(!unconditional.some(rule => rule.names.includes(name)), name);
});

test("AppArmor retains every upstream denial and confines signal and ptrace peers", async () => {
  const policy = await read("runtime/apparmor.profile");
  const upstream = await read("runtime/moby-apparmor-template.go");
  const denials = upstream.split("\n").map(line => line.trim()).filter(line => line.startsWith("deny ")).map(line => line.split("#")[0].trim());
  assert.ok(denials.length >= 25);
  for (const denial of denials) assert.ok(policy.includes(denial), denial);
  assert.match(policy, /abi <abi\/4\.0>,/);
  assert.match(policy, /#include <tunables\/global>/);
  assert.match(policy, /#include <abstractions\/base>/);
  assert.match(policy, /profile "excalidash-mcp-browser" flags=\(attach_disconnected,mediate_deleted\)/);
  assert.match(policy, /^  userns,$/m);
  assert.match(policy, /^  network unix,$/m);
  assert.match(policy, /signal \(send,receive\) peer="excalidash-mcp-browser",/);
  assert.match(policy, /ptrace \(trace,tracedby,read,readby\) peer="excalidash-mcp-browser",/);
  assert.doesNotMatch(policy, /^\s*(?:signal|ptrace)\s*,|flags=\([^)]*unconfined/m);
  const provenance = await read("runtime/PROVENANCE.md");
  for (const pin of ["84e2bdcaa5a6e4a9e8afcbe8b1bca4ff8a8cb69a", "4b8214fc4971e06172938a1f1554ccff6647ee80"]) assert.ok(provenance.includes(pin));
  for (const file of ["runtime/LICENSE-PLAYWRIGHT", "runtime/LICENSE-MOBY"]) assert.match(await read(file), /Apache License/);
});

test("offline smoke rejects root, privilege escalation, capabilities and missing seccomp", async () => {
  const { verifyConfinement } = await import("./browser-smoke.mjs");
  const status = "NoNewPrivs:\t1\nCapEff:\t0000000000000000\nSeccomp:\t2\n";
  assert.doesNotThrow(() => verifyConfinement(1000, status));
  assert.throws(() => verifyConfinement(0, status), /non-root/);
  for (const [before, after] of [["NoNewPrivs:\t1", "NoNewPrivs:\t0"], ["CapEff:\t0000000000000000", "CapEff:\t0000000000000001"], ["Seccomp:\t2", "Seccomp:\t0"]]) {
    assert.throws(() => verifyConfinement(1000, status.replace(before, after)));
  }
  assert.throws(() => verifyConfinement(1000, ""));
});

test("offline smoke requires positive namespace and seccomp-BPF browser evidence", async () => {
  const { verifySandbox } = await import("./browser-smoke.mjs");
  const report = "Sandbox Status\nNamespace sandbox\tYes\nSeccomp-BPF sandbox\tYes\nYou are adequately sandboxed.";
  assert.doesNotThrow(() => verifySandbox(report));
  assert.throws(() => verifySandbox(report.replace("Namespace sandbox\tYes", "Namespace sandbox\tNo")), /Namespace/);
  assert.throws(() => verifySandbox(report.replace("Seccomp-BPF sandbox\tYes", "Seccomp-BPF sandbox\tNo")), /Seccomp/);
  assert.throws(() => verifySandbox(""));
});

test("offline smoke validates PNG dimensions, version, renderer and source immutability", async () => {
  const { verifyRender } = await import("./browser-smoke.mjs");
  const source = { version: 3, elements: [{ x: -100, y: -40 }] };
  const snapshot = structuredClone(source);
  const png = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(600, 16); png.writeUInt32BE(200, 20);
  const result = { png, width: 600, height: 200, version: 3, renderer: "@excalidraw/excalidraw@0.18.1", bounds: { x: -120, y: -60, width: 600, height: 200 } };
  assert.doesNotThrow(() => verifyRender(source, snapshot, result));
  const corruptSignature = Buffer.from(png);
  corruptSignature[0] = 0;
  assert.throws(() => verifyRender(source, snapshot, { ...result, png: corruptSignature }), /89504e470d0a1a0a/);
  for (const change of [{ version: 2 }, { renderer: "other" }, { width: 601 }, { height: 201 }, { png: Buffer.alloc(33) }, { png: Buffer.alloc(4 * 1024 * 1024 + 1) }, { bounds: { x: 0, y: 0 } }]) {
    assert.throws(() => verifyRender(source, snapshot, { ...result, ...change }));
  }
  assert.throws(() => verifyRender({ ...source, version: 4 }, snapshot, result));
  const smoke = await read("scripts/browser-smoke.mjs");
  assert.match(smoke, /verifyConfinement\(process\.getuid/);
  assert.match(smoke, /verifySandbox\(await page\.locator/);
  assert.match(smoke, /chromiumSandbox: true/);
  assert.match(smoke, /chrome:\/\/sandbox/);
  assert.match(smoke, /await renderDrawing\(scene\)/);
  assert.match(smoke, /verifyRender\(scene, snapshot, result\)/);
  for (const text of ["Client", "API", "HTTPS"]) assert.ok(smoke.includes(`"${text}"`));
  assert.doesNotMatch(smoke, /--no-sandbox|--disable.*sandbox|EXCALIDASH_API_KEY|fetch\(/);
});

test("browser target runs isolated with the documented security and resource budget", async () => {
  const makefile = await read("Makefile");
  const target = makefile.slice(makefile.indexOf("browser-smoke:"));
  for (const token of ["Dockerfile.browser", "--network none", "--read-only", "--user node", "--init", "--cap-drop ALL", "--security-opt no-new-privileges", "--security-opt seccomp=runtime/seccomp.json", "--security-opt apparmor=excalidash-mcp-browser", "--memory 2g", "--cpus 2", "--pids-limit 512", "--shm-size 256m", "--tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777", "scripts/browser-smoke.mjs"]) assert.ok(target.includes(token), token);
});


test("sandbox browser receives only a credential-free environment after executable resolution", async () => {
  const { browserLaunchOptions } = await import("./browser-smoke.mjs");
  const executablePath = "/ms-playwright/chromium-synthetic/chrome-linux/chrome";
  const options = browserLaunchOptions(executablePath);
  assert.equal(options.executablePath, executablePath);
  assert.equal(options.chromiumSandbox, true);
  assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "production" });
  const smoke = await read("scripts/browser-smoke.mjs");
  assert.match(smoke, /chromium\.launch\(browserLaunchOptions\(chromium\.executablePath\(\)\)\)/);
  assert.doesNotMatch(smoke, /process\.env/);
});
