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

## Clarifications before implementation

T1 stable types: invalid_geometry, invalid_points, duplicate_id, invalid_reference,
missing_reference, node_overlap, outside_region, outside_frame. Scope live elements
for geometry/relationships and all IDs for duplicates. Missing x/y/width/height is
invalid; absent angle defaults to zero only for bounds computation after checking
any supplied angle. Finite zero width or height allowed for line/arrow/freedraw only;
zero-length connector is invalid. Overlap candidates rectangle/ellipse/diamond/text/
image; visible means !isDeleted, !hidden and opacity !== 0. Substantial overlap is
intersection area >=20% of smaller rotation-aware rectangular polygon AND >=64 world
square units. Use convex polygon clipping for rotated rectangle outlines; ellipse/
diamond check may report conservative warning with explanation about rectangular
bounds. Ignore text-container relations; frame contents are not competing nodes.
Fully-contained same-group decorative pairs are intentional; crossing same-group
shapes still warn. Explicit frameId restricts frame check to its declared children;
unknown frame produces missing_reference issue. Region applies all scoped visible
nodes. Unsupported/unreliable outlines or glyph measurement appear in skippedChecks.
Malformed refs produce invalid_reference; missing live targets missing_reference.
Expose Bounds, InspectionOptions, ValidationOptions and SceneAnalysisError (Error with
readonly details?:Record<string,unknown>) so revision errors carry {code:
"VERSION_CONFLICT",expectedRevision,actualRevision}; no runtime client import.

T3 ownership also includes assets/excalidraw-NOTICES.txt for official renderer and
font license notices, because npm omits license texts. Copy only verified upstream
notices, cite source pins in PROVENANCE via T4. Renderer option and output types can
live in drawing-renderer.ts and need not import analysis until available.

### Plan dry-run corrections

T2 ownership additionally includes src/library-mcp.test.ts: update exact tool count
from 10 to 13 once render is registered (intermediate count 12 before T3); preserve
all old tools/annotations assertions and rename its ten-tool title accurately.
T4 append-only excludes two necessary exact existing prose corrections:
README.md lines 144-146 old:
````md
instructions. The renderer permits generated primitives and escaped text only;
it does not load user SVG, HTML, remote resources, or images. Rendering uses pinned
`@resvg/resvg-js` and bundled DejaVu Sans with system fonts disabled.
````
new:
````md
instructions. Library previews permit generated primitives and escaped text only;
they do not load user SVG, HTML, remote resources, or images. Library previews use
pinned `@resvg/resvg-js` and bundled DejaVu Sans with system fonts disabled.
````
PROVENANCE.md line 19 old:
````md
  Pure helper algorithms are otherwise unchanged.
````
new:
````md
  Scene binding updates now affect only actual geometry dependencies and preserve
  unrelated routes and labels. Shared operation schemas also validate MCP input.
````
Apply exact count-checked replacements; all other existing prose stays intact.

T4 may also update README's tool-count sentence and append three entries to its
existing tool table to match the final 13-tool registration set. Preserve old entries.
Plan dry-run findings on ownership and stale prose are accepted and corrected above.

T3 lifecycle clarification: parent may launch the fresh BrowserServer with explicit
clean environment and chromiumSandbox:true, retain its real process/group identity,
then pass only its private loopback endpoint and sanitized scene over IPC to the
credential-free export worker. Parent owns deadline and kills both worker group and
browser group even when worker is wedged. This is preferable to an inaccessible
worker-owned detached browser. Never expose CDP endpoint in MCP response or logs.
Browser absence is an explicit blocked fidelity check, not successful rendering.

T3 build/CI clarification: npm test and make check require a real sandboxed browser
(no hidden skips). Add test:unit with explicit original unit/protocol test files plus
analysis/mutation tests, excluding only the two new browser integration suites.
Docker build runs test:unit because its preserved Alpine runtime has no browser.
Docker smoke additionally verifies explicit renderer-unavailable failure. Full host
check remains required before image release. T3 ownership additionally includes
.github/workflows/library-ci.yml: preserve pinned actions/security, trigger feature
branches, add pinned playwright-core browser/dependencies installation before full
check. Do not change sandbox/host security policy to force CI green. Browser absence
or user-namespace denial remains a concrete blocked fidelity check.

### T5: Optional isolated real-backend verification helper

Read-only audit found stable backend uses SQLite, not a required Docker service;
therefore attempt a reviewed native fixture before declaring backend unavailable.
Owner implementer; exclusive files scripts/check-backend.mjs and
scripts/backend-fixture.cjs. No installation/start before independent helper review.
Use pinned public stable source 0f9be2d8649be7650e6bee2844739c584fa76c35 in fresh
mkdtemp scratch, verify resolved commit/archive identity, never existing deployments.
Inspect backend package/lock, auth integration tests, config registry and actual routes.
Install locked dependencies isolated (no user npm config, clean child env), then
explicit native/Prisma generation needed from implementation. No production dotenv,
cookies, admin scopes or fallback. Seed synthetic USER and API key with only drawings
read/write using actual upstream helpers/Prisma. Credentials stay IPC memory and never
stdout/disk; prepare IPC handoff before generating. SQLite, uploads, backups and cache
live under task scratch. Bind only 127.0.0.1 on allocated port; health timeout and cleanup
only owned process groups/scratch. No broad prune. Do not weaken browser sandbox.
Backend API root lacks /api; fixture client Fetch wrapper may remove exactly /api
for this upstream root route, documented adapter only, no production client change.
Use real client + InMemory MCP protocol to perform create/checkpoint, inspect version,
add shapes/labels/arrows with refs, structured read, official render, introduce overlap,
validate/refine/rerender, stale revision and backend CAS rejection, invalid batch atomicity,
read-back. Backend CAS race uses observed version in direct authenticated API PUT once
(no auto retry), or intercepted fresh GET that advances actual backend before MCP PUT.
Checkpoint committed IDs/versions/completed assertions immediately into protected
scratch JSON without credentials, so later assertion failure cannot repeat successful
creates/inserts. Report real backend pass separately from loopback mocks. Library scope
patch absent in upstream stable; Library integration remains existing isolated mocks.
Gate before execution: node --check both helpers, independent plan-reviewer read-only
check of helpers against pinned upstream contract. Execution gate: node
scripts/check-backend.mjs with local sandboxed render browser environment. Save log and
precise blockers (native install/Prisma/runtime) if setup cannot run, no false PASS.
Document completion or blocker in README through T4. No source/service modifications
outside task scratch, no deployment. This extends required verification, not product API.

T3 official crop correction: exportingFrame cannot be used as an arbitrary crop frame
because official exporter excludes foreign frame children. Whole scene uses official
exportToCanvas normally. Explicit region may use official exportToSvg (with official
local font subsetting), adjust only root viewBox/width/height and rasterize to capped
browser canvas. No user SVG accepted. Allow CSP wasm-unsafe-eval solely for bundled
official font-subsetting code, no unsafe-eval/workers or external resources. Add crop
text/frame-child pixels comparison to independently cropped whole-scene output.
Valid named/rgb/hsl colors must be preserved, or unsupported style explicitly rejected,
never silently substituted. Invalid user CSS colors fail; absent colors default normally.

## Iteration 1: reviewed helper lifecycle fix

T5F owner same implementer, scope scripts/check-backend.mjs only. Independent helper
review proved detached setup children survive parent SIGTERM. Register SIGINT/SIGTERM
handlers before first spawn, track every owned setup and fixture process group, kill
only those groups and await exit, preserve bounded timeout cleanup. Verify with safe
dummy child/grandchild probes for both signals in private scratch, no backend install.
Run node --check both helpers, obtain fresh read-only reviewer verdict bound to hashes
before executing isolated installation/backend. No changes to backend/API behavior.

T3 region CSP refinement: official font subsetting uses runtime Function via Emscripten,
which would require forbidden unsafe-eval. Do not enable it. Use official exportToSvg
with skipInliningFonts:true, preload local official font faces using capped 1x1 official
Canvas export, mount only that generated SVG DOM at bounded viewport/viewBox, then
sandboxed browser screenshot. Exact output dimensions/deviceScaleFactor1, body margin0,
transparent background semantics preserved. No input SVG/HTML accepted. CSP violations
fatal; no runtime Function allowance. Keep independent text ROI/frame pixel tests and
report actual pipeline. Whole scene remains official Canvas export.

T3 local font fallback restriction: official initialization registers local plus CDN
fallback sources; Chrome can emit CSP violations for the latter before route handling.
Fixed trusted bootstrap may wrap native FontFace constructor to retain only inventoried
renderer.invalid/fonts sources, reject missing local source, and use native FontFace
for real loading. No user font URL/data registration, no CDN fallback. Explicitly await
required official faces and verify loaded status; system font limitations documented.
Record this environment adaptation and upstream notices in PROVENANCE.

## Iteration 2: resume actual native checkpoint

Native setup succeeded against real stable SQLite backend. Create/inspect and graph
batch committed at revision2; initial render assertion failed during renderer CSP/font
work. Do not rerun fresh create/insert. T5R same implementer ownership both helpers:
add --resume <owned-scratch> that validates protected checkpoint/source/archive pins,
reuses existing installed source and SQLite, restarts fixture with upserted synthetic
USER/SystemConfig and new ephemeral drawing-only credential via prepared IPC (old
fixture credential unavailable by design). Never duplicate existing drawing or graph.
On resume verify saved drawing version/IDs against checkpoint before dependent writes;
select recorded drawing, skip already committed writes by checkpoint labels, derive
existing graph IDs from saved geometry, resume render and remaining checks. Extend
labels/checkpoint handling so later successful introduce/refine/CAS stages also never
repeat on resume; expected version mismatch aborts for investigation. Uncertain writes
require readback and explicit mismatch handling, no blind replay. Keep original owned
signal cleanup and clean env. Syntax gates and independent focused helper review of
resume logic before execution. Resume exact protected scratch path supplied privately;
no production state. Save original failed output and eventual successful output separately.

T5R may strengthen actual preservation with a separately checkpointed version-guarded
backend PUT on the owned drawing to seed nonempty synthetic appState and unused valid
synthetic raster files. Derive accepted keys from inspected actual update route; no
asset route/cookie fallback. Check resulting GET retains them across semantic writes.
Skip this committed seed on resume. No image element is necessary because stable
managed image delivery may need broader auth and is separately documented unsupported.
Mock protocol already exercises manual routes, Library groups and ordering in depth.

## Iteration 3: invalid scene background must fail explicitly

Independent T3 review proved invalid appState.viewBackgroundColor values (notacolor,
url(...)) succeed as white. T3F owner same renderer implementer; exclusive scope
src/drawing-renderer.ts and src/drawing-renderer.test.ts. When supplied, invalid scene
background CSS must throw before browser launch; only an absent value defaults white.
Valid scene colors and background=false transparency remain unchanged. Replace old
invalid-background-fallback expectation with meaningful assert.rejects, observe RED
before source edit, run targeted test then renderer scoped gate. Fresh reviewer verdict
for changed hashes, no changes to official exporters/worker or existing security policy.

## Iteration 4: protocol fixture recovery assertion

T4F same implementer ownership src/workflow-mcp.test.ts only. Independent real-protocol
gate fails both transports because text wrapping produces text="Committed\nonce" with
originalText="Committed once". Assert saved originalText (or stable IDs/containment)
to prove single committed label; retain exactly-one-PUT and no replay assertions.
Strengthen targeted refine proof: assert right.x advanced exactly30 and deep equality
of unrelated elements (excluding actual binding/label dependencies). Existing full
protocol failure is RED evidence. Run scoped build+both protocol tests, fix genuine
fixture mistakes without altering actual applier/renderer behavior; fresh reviewer hash.

## Iteration 5: bound selection preprocessing

Independent isolated child probe: 2000-node group chain +100000 repeated missing label
refs is only3419575B but blocks synchronously before any await; killed at4.5s whereas
no-ref same chain finishes389ms. Current repeated fixed-point traversal rescans selected
adjacency each pass and preparation precedes renderer deadline. T3S same implementer
scope drawing-renderer.ts/test only: replace selection closure with indexed queue/BFS.
Index live IDs, groups, frame children, container labels once; process each element and
each group once; selected arrows add endpoints, containers add bound text only, groups/
frames recursively expand, preserve original array order in final selection. Repeated
missing refs are scanned once, no whole-graph expansion from unselected arrows.
Validate malformed relationship collections explicitly. Include preprocessing elapsed
in overall15s budget (start before preparation, use remaining time for launch and
worker deadline), preserve immediate busy/error cleanup. Add deterministic test-first
counter regression: group-chain root relationship getter is read at most a small fixed
constant (e.g.20) independent of chain length, old traversal must fail, missing browser
path prevents actual browser. Retain real pixel/selection semantics tests. Scoped gate,
fresh review and safe same-size adversarial probe; no further scope expansion. This
is final allowed plan fix iteration; remaining environment blockers must be reported.
