import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, fork } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rename, access, chmod, stat, lstat, readFile, realpath, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { ExcaliDashClient } from "../dist/excalidash.js";
import { createServer } from "../dist/index.js";

const SOURCE_COMMIT = "0f9be2d8649be7650e6bee2844739c584fa76c35";
const SOURCE_SHA256 = "a9984fbb59e7710f5a402f1a0fc2b0349b18eeb4474d1753d4e36a73880d59e2";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--resume")) throw new Error("Usage: check-backend.mjs [--resume <owned-scratch>]");
const resuming = args.length === 2;
const scratch = resuming ? await realpath(args[1]) : await mkdtemp(join(tmpdir(), "excalidash-real-backend-"));
if (!resuming) await chmod(scratch, 0o700);
const scratchInfo = await lstat(scratch);
assert.ok(scratchInfo.isDirectory() && !scratchInfo.isSymbolicLink());
assert.equal(scratchInfo.uid, process.getuid?.() ?? scratchInfo.uid);
assert.equal(scratchInfo.mode & 0o777, 0o700);
assert.equal(dirname(await realpath(scratch)), await realpath(tmpdir()), "Resume only task scratch under system temporary directory");
assert.ok(scratch.split("/").at(-1).startsWith("excalidash-real-backend-"));
const backend = join(scratch, "source", "backend");
const checkpointPath = join(scratch, "checkpoint.json");
const state = resuming ? JSON.parse(await readFile(checkpointPath, "utf8")) : { sourceCommit: SOURCE_COMMIT, archiveSha256: SOURCE_SHA256, completed: [], writes: [] };
if (resuming) {
  const checkpointInfo = await lstat(checkpointPath);
  assert.ok(checkpointInfo.isFile() && !checkpointInfo.isSymbolicLink());
  assert.equal(checkpointInfo.uid, scratchInfo.uid);
  assert.equal(checkpointInfo.mode & 0o777, 0o600);
  assert.equal(state.sourceCommit, SOURCE_COMMIT); assert.equal(state.archiveSha256, SOURCE_SHA256);
  assert.ok(state.completed.includes("isolated-native-setup"));
  assert.ok(Array.isArray(state.writes) && typeof state.drawingId === "string" && Number.isSafeInteger(state.version));
}
let fixture;
let api;
let protocol;
let server;
let stage = "prepare";
let fixtureOrigin;
let fixtureToken;
let raceNext = false;
let putCount = 0;

// Keep group ownership until cleanup, even if the leader exits before descendants.
const ownedGroups = new Set();
let stopping = false;
function trackOwned(child) {
  const record = { child, pid: child.pid, exited: new Promise(resolveExit => {
    child.once("exit", resolveExit);
    child.once("error", resolveExit);
  }) };
  ownedGroups.add(record);
  return record;
}
function signalOwned(record, signal) {
  if (!record.pid) return;
  try { process.kill(process.platform === "win32" ? record.pid : -record.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
async function stopOwned(record) {
  signalOwned(record, "SIGKILL");
  let timer;
  try {
    await Promise.race([record.exited, new Promise(resolveWait => { timer = setTimeout(resolveWait, 3000); })]);
  } finally { clearTimeout(timer); ownedGroups.delete(record); }
}
async function stopAllOwned() {
  await Promise.all([...ownedGroups].map(stopOwned));
}
for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void stopAllOwned().then(() => process.exit(exitCode), () => process.exit(1));
  });
}

async function checkpoint() {
  const pending = `${checkpointPath}.tmp`;
  await writeFile(pending, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(pending, checkpointPath);
}
async function completed(name) { if (!state.completed.includes(name)) state.completed.push(name); await checkpoint(); }
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp"),
  XDG_CACHE_HOME: join(scratch, "cache"),
  NPM_CONFIG_USERCONFIG: join(scratch, "npm-user.conf"),
  NPM_CONFIG_GLOBALCONFIG: join(scratch, "npm-global.conf"),
  NPM_CONFIG_CACHE: join(scratch, "npm-cache"),
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_AUDIT: "false",
  DATABASE_URL: `file:${join(scratch, "fixture.db")}`,
  BACKEND_HOST: "127.0.0.1", NODE_ENV: "production", AUTH_MODE: "local",
  JWT_SECRET: randomBytes(32).toString("hex"), CSRF_SECRET: randomBytes(32).toString("hex"),
  API_KEY_HASH_PEPPER: randomBytes(32).toString("hex"),
  FRONTEND_URL: "http://127.0.0.1", UPDATE_CHECK_OUTBOUND: "false", MAIL_TRANSPORT: "none",
  BACKUP_DIR: join(scratch, "backups"),
};

async function command(executable, args, cwd, label, timeout = 180_000) {
  if (stopping) throw new Error("Fixture is stopping");
  const child = spawn(executable, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const owned = trackOwned(child);
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-100_000); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-100_000); });
  const timer = setTimeout(() => { signalOwned(owned, "SIGKILL"); }, timeout);
  try {
    const code = await new Promise((resolveCode, reject) => { child.once("error", reject); child.once("exit", resolveCode); });
    await writeFile(join(scratch, `${label}.log`), output, { mode: 0o600 });
    if (code !== 0) throw new Error(`${label} failed (${code}); inspect protected ${label}.log`);
  } finally { clearTimeout(timer); await stopOwned(owned); }
}

function json(result) {
  const item = result.content?.find(value => value.type === "text");
  assert.ok(item, "Tool returns text");
  return JSON.parse(item.text);
}
const call = (name, args = {}) => protocol.callTool({ name, arguments: args });
async function writeTool(name, args, label) {
  const previous = state.writes.find(write => write.label === label);
  if (previous) {
    assert.equal(previous.isError, false, "Do not replay an unsuccessful/uncertain checkpointed write");
    return { result: { isError: false }, value: previous, reused: true };
  }
  if (state.pending) throw new Error("Uncertain previous write requires explicit readback investigation; no replay");
  state.pending = { label, tool: name, beforeRevision: args.expectedRevision ?? null };
  await checkpoint();
  const result = await call(name, args);
  const value = json(result);
  const drawing = value.drawing;
  state.writes.push({ label, isError: result.isError === true,
    drawingId: drawing?.id ?? state.drawingId,
    version: drawing?.version ?? value.version ?? null, beforeRevision: args.expectedRevision ?? null,
    createdIds: value.createdIds ?? [], changedIds: value.changedIds ?? [],
  });
  if (drawing?.id) state.drawingId = drawing.id;
  if (Number.isSafeInteger(drawing?.version ?? value.version)) state.version = drawing?.version ?? value.version;
  delete state.pending;
  await checkpoint();
  return { result, value };
}
async function direct(path, options = {}) {
  assert.ok(fixtureOrigin && fixtureToken);
  return fetch(`${fixtureOrigin}${path}`, { ...options,
    headers: { Authorization: `Bearer ${fixtureToken}`, "Content-Type": "application/json", ...options.headers },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
}
async function scene() {
  const response = await direct(`/drawings/${encodeURIComponent(state.drawingId)}`);
  assert.equal(response.status, 200);
  return response.json();
}
async function render(label) {
  if (state.completed.includes(label)) return;
  const result = await call("render_drawing", { padding: 10 });
  assert.ok(!result.isError, "Official render succeeds");
  const metadata = json(result);
  assert.equal(metadata.version, state.version);
  assert.equal(metadata.renderer, "@excalidraw/excalidraw@0.18.1");
  const image = result.content.find(value => value.type === "image");
  assert.equal(image?.mimeType, "image/png");
  await writeFile(join(scratch, `${label}.png`), Buffer.from(image.data, "base64"), { mode: 0o600 });
  await completed(label);
}

try {
  if (!resuming) {
  await checkpoint();
  for (const dir of ["home", "tmp", "cache", "backups", "source"]) await mkdir(join(scratch, dir), { mode: 0o700 });
  for (const name of ["npm-user.conf", "npm-global.conf"]) await writeFile(join(scratch, name), "", { mode: 0o600 });
  stage = "download-pinned-source";
  const response = await fetch(`https://codeload.github.com/ZimengXiong/ExcaliDash/tar.gz/${SOURCE_COMMIT}`, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 64 * 1024 * 1024) throw new Error("Pinned source exceeds 64 MiB");
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);
  assert.equal(createHash("sha256").update(archive).digest("hex"), SOURCE_SHA256, "Immutable public source identity");
  await writeFile(join(scratch, "source.tar.gz"), archive, { mode: 0o600 });
  await command("/usr/bin/tar", ["-xzf", join(scratch, "source.tar.gz"), "--strip-components=1", "-C", join(scratch, "source")], scratch, "extract");
  for (const name of [".env", ".npmrc"]) {
    try { await access(join(backend, name)); throw new Error(`Unexpected public source ${name}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  stage = "install-locked-native-dependencies";
  const npm = join(dirname(process.execPath), "npm");
  await command(npm, ["ci", "--ignore-scripts", "--include=dev"], backend, "npm-ci");
  await command(npm, ["rebuild", "bcrypt", "better-sqlite3"], backend, "native-rebuild");
  const prisma = join(backend, "node_modules", "prisma", "build", "index.js");
  stage = "prisma-generate-and-isolated-db";
  await command(process.execPath, [prisma, "generate"], backend, "prisma-generate");
  await command(process.execPath, [prisma, "db", "push", "--skip-generate"], backend, "prisma-db-push");
  await completed("isolated-native-setup");
  } else {
    stage = "verify-resume-pins";
    for (const name of ["source.tar.gz", "fixture.db", "source", "source/backend"]) {
      const info = await lstat(join(scratch, name));
      assert.ok(!info.isSymbolicLink(), "Resume files/directories cannot be symlinks");
      assert.equal(info.uid, scratchInfo.uid);
    }
    assert.equal(createHash("sha256").update(await readFile(join(scratch, "source.tar.gz"))).digest("hex"), SOURCE_SHA256);
    // Compare every original source file with the pinned archive; generated additions
    // such as node_modules/ and generated Prisma clients are intentionally extra.
    const verifiedSource = await mkdtemp(join(scratch, "resume-pin-check-"));
    try {
      await command("/usr/bin/tar", ["-xzf", join(scratch, "source.tar.gz"), "--strip-components=1", "-C", verifiedSource], scratch, "resume-extract");
      const compare = async (original, installed) => {
        for (const entry of await readdir(original, { withFileTypes: true })) {
          const left = join(original, entry.name), right = join(installed, entry.name);
          const info = await lstat(right);
          assert.ok(!info.isSymbolicLink(), "Installed pinned source cannot be symlinked");
          if (entry.isDirectory()) { assert.ok(info.isDirectory()); await compare(left, right); }
          else if (entry.isFile()) assert.deepEqual(await readFile(right), await readFile(left), "Installed source differs from pinned archive");
          else throw new Error("Unsupported pinned source entry");
        }
      };
      await compare(verifiedSource, join(scratch, "source"));
    } finally { await rm(verifiedSource, { recursive: true, force: true }); }
    for (const name of [".env", ".npmrc"]) {
      try { await access(join(backend, name)); throw new Error(`Unexpected source ${name}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const previousCheckpoint = join(scratch, `checkpoint-before-resume-${Date.now()}.json`);
    await writeFile(previousCheckpoint, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  stage = "start-synthetic-backend";
  if (stopping) throw new Error("Fixture is stopping");
  fixture = fork(join(root, "scripts", "backend-fixture.cjs"), [], {
    cwd: backend, env, execArgv: [], detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  trackOwned(fixture);
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("Backend fixture start timeout")), 30_000);
    fixture.once("error", reject);
    fixture.once("exit", () => reject(new Error("Backend fixture exited before ready")));
    fixture.once("message", message => { clearTimeout(timer); message.ready ? resolveReady(message) : reject(new Error("Backend seed/start failed")); });
  });
  // Prepare the receiving channel before generating any credential in the child.
  fixture.send({ action: "start", ...(resuming ? { drawingId: state.drawingId } : {}) });
  const credentials = await ready;
  fixtureOrigin = credentials.origin; fixtureToken = credentials.token;
  assert.equal(new URL(fixtureOrigin).hostname, "127.0.0.1");
  assert.equal((await fetch(`${fixtureOrigin}/health`, { signal: AbortSignal.timeout(1000) })).status, 200);
  api = new ExcaliDashClient({ url: fixtureOrigin, token: fixtureToken, apiMode: "rest" }, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, fixtureOrigin);
    assert.ok(url.pathname.startsWith("/api/"));
    // Only this fixture adapts the upstream backend's root routes, no production change.
    url.pathname = url.pathname.slice(4);
    if (init?.method === "PUT") putCount++;
    const result = await fetch(url, init);
    if (raceNext && init?.method !== "PUT" && /^\/drawings\/[^/]+$/.test(url.pathname)) {
      raceNext = false;
      const observed = await result.clone().json();
      state.pending = { label: "concurrent-backend-write", beforeRevision: observed.version };
      await checkpoint();
      const raced = await direct(url.pathname, { method: "PUT", body: JSON.stringify({ elements: observed.elements, version: observed.version }) });
      assert.equal(raced.status, 200);
      const saved = await raced.json();
      state.writes.push({ label: "concurrent-backend-write", isError: false, drawingId: state.drawingId, beforeRevision: observed.version, version: saved.version, createdIds: [] });
      state.version = saved.version; delete state.pending; await checkpoint();
    }
    return result;
  });
  protocol = new Client({ name: "isolated-real-backend-verification", version: "1.0.0" });
  server = createServer(api);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await protocol.connect(clientTransport);
  stage = "real-backend-workflow";
  if (resuming) {
    const saved = await scene();
    assert.equal(saved.id, state.drawingId);
    assert.equal(saved.version, state.version, "Saved revision changed since checkpoint; investigate before continuing");
    const expectedIds = state.writes.filter(write => write.isError === false).flatMap(write => write.createdIds ?? []);
    assert.deepEqual(saved.elements.map(element => element.id), expectedIds, "Saved IDs/order differ from committed checkpoint");
    if (state.pending) throw new Error("Uncertain previous write requires explicit readback investigation; no replay");
    const selected = await call("select_drawing", { drawingId: state.drawingId });
    assert.ok(!selected.isError);
  }
  const created = await writeTool("create_drawing", { name: "Synthetic isolated workflow" }, "create-drawing");
  assert.ok(!created.result.isError);
  assert.ok(state.drawingId);
  const inspected = json(await call("get_drawing_elements", { mode: "detailed" }));
  assert.equal(inspected.version, state.version);
  if (!state.completed.includes("create-and-inspect")) {
    assert.equal(inspected.totalCount, 0); await completed("create-and-inspect");
  }
  const populated = await writeTool("apply_drawing_ops", { expectedRevision: state.version, ops: [
    { op: "add_shape", ref: "source", shape: "rectangle", x: -120, y: 0, w: 120, h: 80, label: "Source" },
    { op: "add_shape", ref: "target", shape: "rectangle", x: 260, y: 0, w: 120, h: 80, label: "Target" },
    { op: "connect", fromId: "$source", toId: "$target", label: "Flow" },
  ] }, "add-bound-graph");
  assert.ok(!populated.result.isError);
  const geometry = json(await call("get_drawing_elements", { mode: "detailed" }));
  assert.equal(geometry.version, state.version);
  const source = geometry.elements.find(element => element.type === "rectangle" && element.x === -120);
  const target = geometry.elements.find(element => element.type === "rectangle" && element.x === 260);
  assert.ok(source && target);
  assert.ok(geometry.elements.some(element => element.type === "arrow" && element.startBinding?.elementId === source.id && element.endBinding?.elementId === target.id));
  assert.equal(geometry.elements.filter(element => element.type === "text").length, 3);
  state.elementIds = { source: source.id, target: target.id }; await checkpoint();
  await completed("refs-bindings-and-structured-geometry");
  if (!state.writes.some(write => write.label === "seed-preserved-state")) {
    const beforeSeed = await scene();
    state.pending = { label: "seed-preserved-state", beforeRevision: beforeSeed.version }; await checkpoint();
    const seededResponse = await direct(`/drawings/${encodeURIComponent(state.drawingId)}`, {
      method: "PUT", body: JSON.stringify({ version: beforeSeed.version, elements: beforeSeed.elements,
        appState: { viewBackgroundColor: "#f9fafb", syntheticFixture: { preserve: true } },
        files: { "synthetic-unused-raster": { id: "synthetic-unused-raster", mimeType: "image/png", created: 0,
          dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l8AAAAASUVORK5CYII=" } },
      }),
    });
    const seeded = await seededResponse.json();
    if (seededResponse.status === 200 && Number.isSafeInteger(seeded.version)) {
      state.writes.push({ label: "seed-preserved-state", isError: false, drawingId: state.drawingId,
        beforeRevision: beforeSeed.version, version: seeded.version, createdIds: [] });
      state.version = seeded.version; delete state.pending; await checkpoint();
    }
    assert.equal(seededResponse.status, 200);
    assert.deepEqual(seeded.elements, beforeSeed.elements);
    assert.equal(seeded.appState.syntheticFixture.preserve, true);
    assert.ok(seeded.files["synthetic-unused-raster"]);
  }
  const preservedSeed = await scene();
  assert.equal(preservedSeed.appState.syntheticFixture.preserve, true);
  assert.ok(preservedSeed.files["synthetic-unused-raster"]);
  await completed("nonempty-appstate-and-file-seeded");
  await render("initial-render");
  const overlap = await writeTool("apply_drawing_ops", { expectedRevision: state.version, ops: [
    { op: "add_shape", ref: "overlap", shape: "rectangle", x: -100, y: 10, w: 120, h: 80 },
  ] }, "introduce-overlap");
  assert.ok(!overlap.result.isError);
  const overlapId = overlap.value.createdIds[0]; assert.ok(overlapId);
  if (!state.completed.includes("deliberate-overlap-detected")) {
    const bad = json(await call("validate_drawing"));
    assert.ok(bad.issues.some(issue => issue.type === "node_overlap" && issue.elementIds.includes(source.id) && issue.elementIds.includes(overlapId)));
    await completed("deliberate-overlap-detected");
  }
  if (!state.beforeRefine) { state.beforeRefine = await scene(); await checkpoint(); }
  const beforeRefine = state.beforeRefine;
  const refined = await writeTool("apply_drawing_ops", { expectedRevision: state.version, ops: [{ op: "move", id: overlapId, x: 500, y: 180 }] }, "refine-overlap-only");
  assert.ok(!refined.result.isError);
  const afterRefine = await scene();
  assert.deepEqual(afterRefine.elements.filter(element => element.id !== overlapId), beforeRefine.elements.filter(element => element.id !== overlapId));
  assert.deepEqual(afterRefine.appState, beforeRefine.appState); assert.deepEqual(afterRefine.files, beforeRefine.files);
  assert.deepEqual(afterRefine.elements.map(element => element.id), beforeRefine.elements.map(element => element.id));
  const good = json(await call("validate_drawing"));
  assert.ok(!good.issues.some(issue => issue.type === "node_overlap" && issue.elementIds.includes(overlapId)));
  await completed("validate-targeted-refinement-preservation");
  await render("refined-render");
  if (!state.beforeFailures) { state.beforeFailures = await scene(); await checkpoint(); }
  const beforeFailures = state.beforeFailures;
  const writesBeforeStale = putCount;
  if (!state.completed.includes("stale-and-invalid-batch-atomicity")) {
  const stale = await call("apply_drawing_ops", { expectedRevision: 0, ops: [{ op: "delete", id: source.id }] });
  assert.equal(stale.isError, true); assert.equal(putCount, writesBeforeStale);
  assert.equal(stale.structuredContent.error.code, "VERSION_CONFLICT");
  const invalid = await call("apply_drawing_ops", { expectedRevision: state.version, ops: [
    { op: "add_shape", shape: "ellipse", x: 800, y: 0 }, { op: "move", id: "synthetic-missing", dx: 1 },
  ] });
  assert.equal(invalid.isError, true); assert.equal(putCount, writesBeforeStale);
  assert.deepEqual(await scene(), beforeFailures);
  await completed("stale-and-invalid-batch-atomicity");
  }
  if (!state.completed.includes("actual-backend-cas-rejection-and-readback")) {
    const priorRace = state.writes.find(write => write.label === "concurrent-backend-write");
    if (priorRace && !state.casOutcome) {
      // A concurrent commit is known, but the adapter response was lost. Prove the
      // backend's rejection using its recorded stale revision, never repeat that commit.
      const rejected = await direct(`/drawings/${encodeURIComponent(state.drawingId)}`, {
        method: "PUT", body: JSON.stringify({ elements: beforeFailures.elements, version: priorRace.beforeRevision }),
      });
      state.casOutcome = { status: rejected.status, resumedReadback: true }; await checkpoint();
      assert.equal(rejected.status, 409);
    } else if (!priorRace) {
      raceNext = true;
      const beforeCasPuts = putCount;
      const raced = await call("apply_drawing_ops", { expectedRevision: state.version, ops: [{ op: "move", id: source.id, dx: 10 }] });
      state.casOutcome = { isError: raced.isError === true, error: raced.structuredContent?.error, adapterPuts: putCount - beforeCasPuts };
      await checkpoint();
      assert.equal(raced.isError, true); assert.equal(putCount, beforeCasPuts + 1);
      assert.equal(raced.structuredContent.error.code, "VERSION_CONFLICT");
    }
    if (state.casOutcome.resumedReadback) assert.equal(state.casOutcome.status, 409);
    else {
      assert.equal(state.casOutcome.isError, true); assert.equal(state.casOutcome.adapterPuts, 1);
      assert.equal(state.casOutcome.error.code, "VERSION_CONFLICT");
    }
    const afterRace = await scene();
    assert.deepEqual(afterRace.elements, beforeFailures.elements);
    assert.ok(afterRace.version > beforeFailures.version);
    state.version = afterRace.version; await checkpoint();
    await completed("actual-backend-cas-rejection-and-readback");
  }
  state.status = "passed"; await checkpoint();
  console.log(`PASS: isolated stable backend workflow; source ${SOURCE_COMMIT}; protected evidence ${scratch}`);
  console.log("Library scope integration is covered by mock fixtures only; upstream stable lacks library:read.");
} catch (error) {
  state.status = "blocked-or-failed"; state.failedStage = stage;
  // Recovery is read-only. Never replay a successful or uncertain create/batch.
  if (fixtureOrigin && fixtureToken && state.drawingId) {
    try {
      const saved = await scene();
      state.recovered = { drawingId: saved.id, version: saved.version, elementIds: saved.elements.map(element => element.id) };
    } catch { state.recovery = "readback-unavailable"; }
  }
  await checkpoint();
  console.error(`FAIL/BLOCKED at ${stage}: ${error instanceof assert.AssertionError ? error.message : (String(error.message).includes(".log") ? error.message : "Inspect source and protected checkpoint; no credentials logged")}`);
  console.error(`Protected evidence: ${scratch}`);
  process.exitCode = 1;
} finally {
  await protocol?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (fixture?.connected) fixture.send({ action: "stop" });
  await stopAllOwned();
  fixtureToken = undefined;
  // Keep the task-owned protected scratch as evidence; never touch unrelated resources.
  const info = await stat(scratch); assert.equal(info.mode & 0o777, 0o700);
}
