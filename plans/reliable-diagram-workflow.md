# Reliable diagram workflow

## Baseline and evidence

Base: `82f52af`, package `0.4.0-library.1`, clean local branch
`feat/excalidash-library`; implementation branch `feat/reliable-diagram-workflow`.
Remote default stays unchanged. All 49 baseline tests pass (`npm ci --ignore-scripts`,
`make check`; archived baseline test output in private task evidence).
No repository AGENTS.md, CLAUDE.md or scoped rules exist. User global instructions
apply. Production and real user data are excluded. Docker CLI exists but daemon
is unavailable. No isolated real backend is configured; protocol fixtures are
explicitly mocks, never presented as real backend verification.

Findings: REST GET drawings/:id already provides authoritative elements, version,
appState and files; promote this reader, retain authenticated request, redirect
refusal, 15s timeout and 10 MiB cap. PUT must remain exactly elements/version.
Summary is text, inspect is JSON {element, children}. Library path stays intact.
Index duplicates opSchemas; reuse opSchema. Scene.rerouteBindings currently rewrites
all bound multipoint routes and labels after any batch. Geometry utilities are
axis-aligned approximations; text width is heuristic, unsuitable for exact clipping.
Group op result contains group IDs; compute element metadata from scene differences.

Compatible source: ExcaliDash v0.6.7 resolves
`0f9be2d8649be7650e6bee2844739c584fa76c35`; frontend lock pins Excalidraw 0.18.1
(MIT). Official exportToBlob/exportToCanvas, getCommonBounds and locally hosted fonts
are usable in a real browser. Managed image URLs may require user auth or redirects;
only inline raster files are accepted for render, with explicit unsupported assets.
Sources: https://github.com/zimengxiong/ExcaliDash/tree/v0.6.7 and
https://github.com/excalidraw/excalidraw/tree/v0.18.1 .

## Goal and acceptance criteria

Read -> Plan -> Apply -> Render -> Validate -> Refine on synthetic saved scenes via
real MCP stdio and Streamable HTTP. Existing ten tools and defaults remain compatible.
Meaningful test-first evidence is saved before source implementation.
`make check` proves unit/protocol integration tests, strict build, audit and diff check.
`make docker-smoke` must be attempted; unavailable daemon is a blocked check, not PASS.
Official browser rendering tests must run when a local sandboxed Chrome is available;
otherwise rendering is incomplete. Visually inspect representative PNG plus independent
content comparisons. No deployment, merge to original branch or remote-default changes.

## Shared definitions and response contracts

- Export RestDrawing (DrawingSummary + elements + optional appState/files) and
  validateScene from rest.ts; public RestAdapter.scene(id) and client.getScene(id)
  reuse the existing request. New read tools require REST mode, reject legacy mode
  clearly. No parallel API client.
- New src/drawing-analysis.ts exports boundsSchema ({x,y,width,height}, finite,
  positive sizes), inspectionOptionsSchema, validationOptionsSchema, types inferred
  from schemas, elementBounds(element): Bounds|null, inspectScene(scene,options),
  validateDrawing(scene,options). Scene argument is structural {version:number,
  elements:ExcalidrawElement[]}; no runtime cycle with rest/client.
- get_drawing_elements input {drawingId?, mode?:compact|detailed (compact), ids?:
  string[1..200], types?:string[1..30], bounds?:Bounds, includeDeleted?:boolean(false),
  offset?:int>=0(0), limit?:int1..200(100), expectedRevision?:safe nonnegative int}.
  Returns JSON {version,elements,totalCount,offset,limit,nextOffset,truncated}.
  Each element includes arrayIndex, stable geometry, text and styles, bindings,
  container/frame/group IDs, index, opacity/hidden/isDeleted/locked. Detailed retains
  all fields. No text truncation; bound serialized page to 1 MiB, explicit pagination
  or explicit single-element-too-large error. Filtering preserves revision. Nonzero
  offset requires expectedRevision; stale versions reject instead of mixing pages.
- validate_drawing input {drawingId?, region?:Bounds, frameId?:string,
  maxIssues?:int1..500(100)}; JSON {version,issues,truncated,skippedChecks}.
  Issue {severity:error|warning|info,type,elementIds,explanation,suggestion?}.
  Validate raw numbers before defaults; negative positions valid; zero line dimensions
  valid; invalid line points/ref shapes produce issues, not crashes. Detect duplicate
  IDs, missing references (container,frame,boundElements,start/end), invalid geometry,
  substantial overlaps of independent visible nodes with rotation-aware rectangular
  bounds. Explicit container/frame membership and fully-contained same-group decoration
  are intentional; shared group alone does not suppress crossing nodes. Check explicit
  region/frame boundaries. Pair checks bounded to 200000; max issues explicit truncation.
  Font clipping and connector obstruction are skipped with reasons until reliable
  measurement exists. Never save/normalize scenes. Deterministic input-order issues.
- apply_drawing_ops gains expectedRevision?:safe nonnegative int. REST compares with
  fresh GET before applying; legacy rejects requested revision as unsupported. Keep
  backend CAS unchanged; no retry. ExcaliDashError optionally carries details;
  readable text error retained and structuredContent {error:{code,...}} additive.
  Stale error code VERSION_CONFLICT, expectedRevision, actualRevision, retry instruction.
  Backend 409 also gets structured code without assuming server revision.
- Keep old mutation response keys. Add createdIds,modifiedIds,deletedIds (element IDs
  only; transitions from/to live including tombstones/physical deletion), changedBounds
  (union of old/new geometry), validationWarnings and validationSkippedChecks. Compute
  from actual before and committed response, retain existing changedIds/result filtering.
- Binding preservation: Scene stores original geometry. Only reroute when bound endpoint
  geometry changed; additions already have geometry. Existing multipoint routes keep
  interior world points, update only affected endpoints; labels move only if route
  actually changes and preserve their metrics/manual offsets. Changes to metadata,
  style, new unrelated elements, grouping do not rewrite routes/labels. Direct route
  move retains requested geometry. Handle single-sided bindings safely. Fresh custom
  fields, appState, files and array order remain untouched by unrelated operations.
- render_drawing input {drawingId?,scale?:number0.1..4(1),background?:boolean(true),
  region?:Bounds,elementIds?:string[1..200],padding?:number0..200(20)}; region and IDs
  exclusive. Returns text JSON {version,bounds:{x,y,width,height},width,height,
  renderer:"@excalidraw/excalidraw@0.18.1",...warnings?} + image/png MCP image.
  One getScene per render; pass same immutable snapshot. Select IDs expands group,
  frame children, bound labels and binding endpoints transitively, bounded to scene.
  Region crops all scene contents, explicit bounds plus padding; whole scene fits
  official bounds + padding. Empty scene is 1x1 content plus padding. Negative
  positions, rotation, multipoint routes handled by official export. Background false
  transparent; true uses valid scene color or white. Scene background/layout state
  selectively whitelisted, never arbitrary user HTML or links.
- Renderer module src/drawing-renderer.ts runs a fresh credential-free child process
  src/render-worker.ts using pinned playwright-core, official 0.18.1 and esbuild.
  Browser bundle src/renderer-entry.ts -> dist/renderer.js, copied local official
  fonts in dist/renderer-fonts. Browser executable requires explicit
  EXCALIDASH_RENDER_BROWSER or pinned Playwright browser installation. Sandbox true,
  never --no-sandbox. Worker receives sanitized snapshot only over IPC; clean env,
  no token/source paths. Browser route fulfills only known immutable local bundle/fonts
  at renderer.invalid; aborts everything else, workers/service workers/downloads off.
  Reject external/SVG image assets; allow bounded inline PNG/JPEG/WebP with signature
  checks, reject malformed/missing assets before browser. Do not execute scene links.
  Limit 2000 live elements, 4096 axis pixels, 4M total pixels, 4 MiB output,
  15s overall deadline, concurrency 1 with immediate busy error, worker heap 128MiB.
  Kill child/process tree on timeout and close browser in finally. Document browser
  memory is outside JS heap cap; do not claim hard host memory guarantee. Browser
  requires separate resource budget; unchanged hardened Alpine runtime does not
  contain supported browser, render explicitly unavailable there. No silent sandbox
  weakening or privilege changes. Host measurements are not deployment sizing.

## Gates

`npm ci --ignore-scripts`
`make check`
`make docker-smoke`
Browser check: `EXCALIDASH_RENDER_BROWSER=<local sandboxed Chrome> npm test`.
Only one full suite at a time. Archive command outputs/status in private evidence.
Before every commit use make check, explicit pathspecs, configured signing, conventional
English subject <=72 chars. Push finished feature branch, do not merge/default-change.

## Tasks and exclusive ownership

### T1: Structured analysis
Owner: implementer; files src/drawing-analysis.ts, src/drawing-analysis.test.ts.
Implement shared pure inspection/validation contracts. First write and run failing
cases using dynamic import through a variable until module exists, save RED output,
report before source work. Cases: full text/order/rotation/bindings/custom detailed,
ID/type/bounds filtering, revision-pinned pagination, 1 MiB pages, empty/10000 scenes,
invalid raw coordinates/line points, zero horizontal/vertical lines, malformed refs,
intentional bound/frame overlaps, crossing same-group nodes, regions/rotations,
computation and issue caps, no mutation. Gate npm run build + node --test
 dist/drawing-analysis.test.js. Mutation: skip invalid coordinates branch or suppress
all same-group overlaps must fail tests. Depends none.

### T2: Safe shared mutation and client seam
Owner: implementer; files src/rest.ts, src/excalidash.ts, src/index.ts,
src/agent/scene.ts, src/agent/opSchemas.ts, src/rest.test.ts,
src/mutation-preservation.test.ts, src/mcp.test.ts.
Depends T1 API, no overlapping source ownership. First preservation/expectedRevision
RED tests and await orchestrator signal. Export scene reader, add analysis tool
registrations, shared opSchema replacing duplicate. Implement all revision/error/
metadata/binding preservation contracts. render registration later delegates to
client.getScene and renderDrawing import in T3 seam; T2 initially omit renderer
registration until T3 exists. Existing ten tool assertions updated additively.
Cases: unrelated style/add/group routes and manual labels byte-preserved, moved bound
endpoints preserve interior bends/label offset, metadata actual saved scene including
physical removal/tombstones/group IDs, stale pre-save rejection/no PUT, CAS one PUT,
legacy rejection, files/appState/custom/order preservation, atomic invalid batch.
Gate npm run build + node --test dist/rest.test.js dist/mutation-preservation.test.js
 dist/mcp.test.js. Mutation: reroute all arrows or remove revision check fails tests.

### T3: Faithful renderer
Owner: implementer; files src/drawing-renderer.ts, src/render-worker.ts,
src/renderer-entry.ts, src/drawing-renderer.test.ts, scripts/build-renderer.mjs,
package.json, package-lock.json, Dockerfile, Makefile. Depends T1 types only.
First RED tests, report and await signal. Implement exact shared render limits,
assets, sandbox and official exporter contracts. Build browser bundle/font assets
via build script and extend Docker source copies; keep rootless read-only Alpine
runtime. No browser installation helper until necessary; any helper fully reviewed.
Gate npm run build + node --test dist/drawing-renderer.test.js. Representative PNGs
saved in private evidence; test independent pixels/content, renderer output comparisons
for route/image/font differences, not just dimensions. Measure elapsed/RSS on host
when possible, explicit inability to prove 256MiB container sizing. Mutation: replace
export with blank PNG or fail to include arrows/fonts must fail fidelity tests.

### T4: Protocol integration and documentation/skill
Owner: implementer; files src/workflow-mcp.test.ts, README.md, PROVENANCE.md,
.agents/skills/excalidash/SKILL.md. Depends T1-T3. Follow installed skill-authoring
format (name/description YAML, focused workflow, no invented parameters). Keep existing
prose intact and append new sections. Protocol synthetic scene storage fixture tests
actual applier/renderer via stdio and HTTP, auth, selection isolation, authoritative
render version, refine only targets, stale/CAS conflicts, atomic failure/readback,
Library/custom/appState/files/order preservation. Record checkpoint before later
assertions; never repeat successful writes in recovery. Clearly mock backend.
Document tools/calls, renderer/limits/assets/runtime, read-before-edit optional revision,
recovery without undo, backend/container blocked checks. Skill includes architecture,
flowchart, editing and messy layout workflows, actual $ref, Library, inspect-revise-
render-validate, no blind retry, no undo/graph claims. Gate npm run build + node --test
 dist/workflow-mcp.test.js; skill quick_validate.py. Independent skill-dry-run before
source implementation (plan) and after final skill.

## Seams

T1 -> T2: analysis schemas/functions and structural scene shared definitions above.
T1 -> T3: Bounds/elementBounds, raw validation; renderer still uses official bounds.
T2 -> T3: client.getScene/RestDrawing; T3 exports renderDrawing(scene,options) Promise
of {png:Buffer,version,bounds,width,height,renderer}; T2 owns final registration.
T1-T3 -> T4: exact schemas in registrations; tests invoke real protocol and applier.

## Not doing and limitations

No production calls/rollout, real accounts, live installation, additional database,
undo/history, graph auto_layout, external image fetching, privilege/sandbox bypass,
remote default changes or merge. Safe undo is not feasible with available REST
history/ownership guarantees; document failed-batch atomicity and uncertain read-back.
Font overflow/connector obstruction remain explicitly skipped until measured reliably.
Current small deployment cannot be certified without a sandboxed browser and resource
measurements in a compatible container. P0/overall workflow remains unverified there.
