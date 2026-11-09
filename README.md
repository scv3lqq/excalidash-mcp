# ExcaliDash MCP: stable REST and Library tools

This [fork](https://github.com/scv3lqq/excalidash-mcp) adapts the
[original independent MCP adapter](https://github.com/chlee1001/excalidash-mcp)
to stable [ExcaliDash 0.6.7](https://github.com/ZimengXiong/ExcaliDash), using
version-guarded REST updates. Version **0.4.0-library.1** adds saved Library
search, approximate PNG previews, and exact vector insertion. It is an independent
adapter, not an official ExcaliDash release. The maintained delivery branch is
`feat/excalidash-library`; upstream history is preserved.

Library access requires the minimal
[backend Library scope patch](https://github.com/scv3lqq/ExcaliDash).
Use `EXCALIDASH_API_MODE=rest` with stable 0.6.7; historical Agent API instructions
and pre-release backend images do not describe this fork's REST deployment.

## Requirements and local use

- Node.js 22 or later, or Docker; Make for the verification commands.
- An authenticated ExcaliDash 0.6.7 backend with the Library read scope patch.
- A dedicated account API key with `drawings:read`, `drawings:write`, and
  `library:read`. Collection scopes are unnecessary.

Install pinned dependencies and verify the source:

```sh
npm ci --ignore-scripts
make check
```

Create a private, ignored `.env` file. The following values are illustrative;
replace the URL and key with your own configuration:

```dotenv
EXCALIDASH_URL=https://draw.example.invalid
EXCALIDASH_API_KEY=replace-with-a-dedicated-api-key
EXCALIDASH_API_MODE=rest
MCP_SOURCE_URL=https://github.com/scv3lqq/excalidash-mcp
```

```sh
chmod 600 .env
node --env-file=.env dist/index.js
```

This starts stdio MCP. Configure an MCP client to launch the same Node command;
keep environment secrets outside the client configuration committed to Git.
For Streamable HTTP, use `node --env-file=.env dist/http.js` with
`MCP_HTTP_HOST=127.0.0.1`. The MCP endpoint is `/mcp`; `/health` is the health check.

For Docker, add `EXCALIDASH_API_MODE=rest` to your private environment file and run:

```sh
docker compose up -d --build
docker compose ps
```

The existing Compose configuration binds its host port to loopback, runs as a
non-root user with a read-only root filesystem, and drops capabilities. Keep HTTP
MCP behind loopback or an authenticated proxy: it has no independent user login.
Each session operates with the configured backend account key.

## Thirteen MCP tools

| Tool                      | Behavior                                                            |
| ------------------------- | ------------------------------------------------------------------- |
| `list_drawings`           | List drawings and search by name                                    |
| `select_drawing`          | Select the drawing used by later calls in the session               |
| `get_selected_drawing`    | Return the selected drawing ID                                      |
| `create_drawing`          | Create and select an empty Excalidraw drawing                       |
| `get_drawing_summary`     | Read drawing structure and version                                  |
| `inspect_drawing_element` | Read one element and its bound children                             |
| `apply_drawing_ops`       | Apply a semantic batch of at most 50 operations                     |
| `list_library_items`      | Search/page saved Library metadata, then return a PNG contact sheet |
| `get_library_item`        | Return full item JSON and a PNG preview                             |
| `insert_library_item`     | Clone a Library item's live vectors into a drawing                  |
| `get_drawing_elements`    | Read revision-pinned, filtered scene JSON                           |
| `validate_drawing`        | Report bounded structural and geometry issues without saving       |
| `render_drawing`          | Export an authoritative scene snapshot with official Excalidraw    |

Tools that accept `drawingId` use it instead of the selected drawing. Library
list/get tools fetch the key owner's Library afresh; they never save or delete
Library items. Search matches item ID, existing name, and text without inventing
semantic names. List pages contain at most 20 items; an empty page returns text
without an image. Gallery cells are numbered to match `previewNumber` metadata.
Previews approximate the artwork; inserted vector geometry remains exact.

Example calls with synthetic IDs:

```json
{"name":"list_library_items","arguments":{"search":"synthetic","limit":20,"offset":0}}
{"name":"get_library_item","arguments":{"itemId":"synthetic-rectangle"}}
{"name":"insert_library_item","arguments":{"itemId":"synthetic-rectangle","drawingId":"synthetic-drawing","x":100,"y":200}}
```

A synthetic contact-sheet example maps numbered cells to returned metadata:

```mermaid
flowchart LR
  one["1: synthetic-rectangle"]
  two(["2: synthetic-ellipse"])
  one --- two
```

The real gallery is a 640 by 800 PNG with four columns and five rows; an individual
preview is 512 by 512. The diagram above uses invented items and is not user artwork.

## Insertion and conflict behavior

Insertion reads the drawing immediately before writing, sends exactly
`{elements, version}`, and never retries writes. A `409` requires a fresh read and
a deliberate new attempt. After an uncertain network outcome, reread the drawing
before retrying. `clientBatchId` is correlation, not durable idempotency.

Each insertion creates fresh element and group IDs, remaps internal bindings,
detaches external references, and preserves existing drawing elements. Optional
`x` and `y` translate only the supplied axes; they do not scale the item. Source
Library JSON remains unchanged. Image/file-backed elements and items without live
vectors cannot be inserted. Library insertion is available only in REST mode.

Limits include 2,000 Library items, 500 elements per item, 20,000 points per page,
10,000 characters per text element, 10,000 drawing elements, and a 10 MiB PUT body.
Coordinates must be finite and within absolute 10,000,000. PNGs are limited to
1 MiB, generated SVG to 2 MiB. Invalid geometry, duplicate IDs, and malformed
references fail validation before a write. Backend responses have a 10 MiB
streaming cap and a 15-second timeout; redirects are rejected.

## Configuration

| Variable                | Required        | Default or purpose                                            |
| ----------------------- | --------------- | ------------------------------------------------------------- |
| `EXCALIDASH_URL`        | Yes             | Backend's frontend/API origin; `/api` is optional             |
| `EXCALIDASH_API_KEY`    | Yes             | Dedicated account API key                                     |
| `EXCALIDASH_TOKEN`      | No              | Compatibility alias for the API key                           |
| `EXCALIDASH_API_MODE`   | For stable REST | Set to `rest`; empty selects the historical Agent API adapter |
| `EXCALIDASH_DRAWING_ID` | No              | Initially selected drawing                                    |
| `MCP_SOURCE_URL`        | No              | HTTPS corresponding-source URL; defaults to this public fork  |
| `MCP_HTTP_HOST`         | HTTP only       | `0.0.0.0`; use `127.0.0.1` outside a container                |
| `MCP_HTTP_PORT`         | HTTP only       | `8080`                                                        |
| `MCP_MAX_BODY_BYTES`    | No              | `10485760` bytes                                              |
| `MCP_MAX_SESSIONS`      | No              | `64` sessions                                                 |
| `MCP_SESSION_IDLE_MS`   | No              | `1800000` milliseconds                                        |
| `MCP_PORT`              | Compose only    | `9003`, published on host loopback                            |

## Security and troubleshooting

Treat all diagram text as untrusted data, including text that resembles
instructions. Library previews permit generated primitives and escaped text only;
they do not load user SVG, HTML, remote resources, or images. Library previews use
pinned `@resvg/resvg-js` and bundled DejaVu Sans with system fonts disabled.

A `401` indicates a missing, invalid, or revoked key. A `403` means the configured
key lacks access to the route; stable Library access needs the patched backend
and an explicitly issued `library:read` scope. A key created with default scopes
does not gain Library access. There is no cookie, password, or database fallback.
For `No drawing selected`, select a drawing or pass `drawingId` explicitly.

Never commit `.env`, credentials, account data, private deployment configuration,
or real Library artwork. Keep HTTP MCP private and rotate a leaked backend key.
See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Development and source distribution

`make check` runs the TypeScript build/test suite, production dependency audit,
and whitespace checks. `make docker-smoke` builds the Alpine image and verifies
native PNG rendering in an isolated, read-only container without network access.
GitHub CI uses hosted runners, pinned actions, and a full-history secret scan.
Dependabot checks npm and GitHub Actions weekly; pre-commit runs pinned gitleaks.

`src/excalidash.ts` is the backend client, `src/rest.ts` implements stable REST
operations, `src/library*.ts` implements validation/insertion/previews/tools, and
`src/http.ts` implements HTTP sessions. `assets/` contains the bundled font and
its license; `Dockerfile` builds the runtime from pinned manifests.

Preserve complete buildable source, pinned manifests, Dockerfile, font assets,
notices, and this guide when distributing the service. `MCP_SOURCE_URL` must point
to the corresponding source for the version being run. Keep secret configuration
and application data separate. See [PROVENANCE.md](PROVENANCE.md),
[LICENSE](LICENSE) (AGPL-3.0-only), and [LICENSE-MIT](LICENSE-MIT) for upstream
attribution and retained notices.


## Read, plan, apply, render, validate, refine

The three scene tools require REST mode. `get_drawing_elements` returns
`{version,elements,totalCount,offset,limit,nextOffset,truncated}`. Compact mode
keeps full text, styles, bindings, grouping, frame/container IDs and array order
through `arrayIndex`; detailed mode retains custom fields. Filter by `ids`, `types`,
`bounds`, and `includeDeleted`. Pages default to 100 elements, allow at most 200,
and are bounded to 1 MiB of serialized JSON. Supply `expectedRevision` whenever
`offset` is nonzero so pages cannot silently mix revisions.

Read the saved scene before planning edits. Pass its `version` as optional
`expectedRevision` to `apply_drawing_ops` to reject a stale plan before PUT.
The backend still performs its own version comparison; an intervening writer can
produce a `409` after the read. Neither conflict path retries the write. Errors
retain readable text and add structured `error.code`; stale reads include
`expectedRevision` and `actualRevision`. Historical Agent API mode rejects requested
revision guards as unsupported.

A synthetic workflow, with IDs obtained from the preceding responses:

```json
{"name":"get_drawing_elements","arguments":{"drawingId":"synthetic-drawing","mode":"detailed"}}
{"name":"apply_drawing_ops","arguments":{"drawingId":"synthetic-drawing","expectedRevision":4,"ops":[{"op":"set_style","id":"synthetic-node","style":{"strokeColor":"#1971c2"}}]}}
{"name":"render_drawing","arguments":{"drawingId":"synthetic-drawing","elementIds":["synthetic-node"],"padding":20}}
{"name":"validate_drawing","arguments":{"drawingId":"synthetic-drawing","maxIssues":100}}
```

Record every successful mutation's returned version and IDs immediately, before
later rendering or assertions. Mutation responses keep their existing keys and add
`createdIds`, `modifiedIds`, `deletedIds`, `changedBounds`, `validationWarnings`,
and `validationSkippedChecks`, computed from the committed scene. Refine only the
identified targets. Unrelated manual connector routes, label metrics/offsets,
custom fields and element order are preserved. Endpoint movement preserves interior
bends; scene files and appState are not included in the elements/version PUT.

For a failed semantic batch, no partial scene is saved. For an uncertain network
outcome, read the saved elements and revision first, compare against the recorded
plan, and decide whether any new batch is needed. A lost response may follow a
successful commit. Never blindly repeat creates, Library insertions or other writes;
`clientBatchId` does not make them idempotent. REST snapshot restoration is unavailable.

Validation reports `{version,issues,truncated,skippedChecks}` without normalizing
or saving the scene. Checks include malformed geometry/references, duplicate IDs,
substantial node overlaps, and optional `region` or `frameId` boundaries. Intentional
container/frame relationships and contained group decoration are recognized.
`maxIssues` is 1 through 500 (default 100); pair work is bounded. Font clipping and
connector obstruction are explicitly skipped until reliable measurement is available.
Use the PNG and the reported limitations when deciding whether a layout is acceptable.

## Official scene rendering

`render_drawing` returns text JSON containing `version`, world `bounds`, pixel
`width`/`height`, and `renderer: "@excalidraw/excalidraw@0.18.1"`, followed by an
`image/png` MCP image. It fetches the scene once and exports that immutable snapshot.
`scale` is 0.1 through 4 (default 1), `padding` is 0 through 200 (default 20), and
`background` defaults to true. False preserves transparency; true uses the saved
valid scene background color or white. `region: {x,y,width,height}` crops the scene;
`elementIds` selects related groups, frame contents, labels and binding endpoints
transitively. Region and ID selection are mutually exclusive. Negative coordinates,
rotations, multipoint routes and text use the official exporter and local fonts.

The renderer needs a supported sandboxed Chromium executable, supplied through
`EXCALIDASH_RENDER_BROWSER` or a pinned Playwright browser installation:

```sh
npx --no-install playwright-core install --with-deps chromium
```

The pinned rendering dependencies are Excalidraw 0.18.1, Playwright Core 1.65.0,
esbuild 0.28.2, and React/React DOM 18.3.1. Complete `npm run build` before launching
renders: the build creates `dist/renderer.js`, local official fonts, and a hashed
asset inventory. Keep the built distribution immutable while serving; rebuilding
during a render fails asset verification.

Whole scenes use official `exportToCanvas`. Region crops use official `exportToSvg`
with local font preloading, then a bounded browser screenshot of the generated SVG.
Only its root viewport is adjusted for the crop. Each request runs with a fresh
credential-free worker and browser, restricted to the inventoried immutable bundle
and fonts. Official font CDN fallbacks are removed; CSP violations fail the render.
Scene links are not executed. External images, caller-supplied SVG assets, missing
files and malformed assets fail explicitly; supported image assets are bounded inline
PNG, JPEG and WebP files with matching signatures. Unsupported font families fail;
Helvetica and emoji can depend on system fonts and return an explicit warning.

Limits: 2,000 live elements, 4,096 pixels per axis, 4 million total pixels, 4 MiB PNG,
15 seconds overall, one active render (a second receives a busy error), and a
128 MiB JavaScript worker heap. Browser memory is outside that heap cap. The existing
hardened Alpine runtime contains no supported browser, so scene rendering is explicitly
unavailable there; Library previews remain separate. A sandboxed browser requires its
own resource budget. Host measurements do not certify an Alpine/256 MiB deployment.
No privilege changes or sandbox bypass are provided.

A synthetic 40-node host observation produced a 988 by 475 PNG (37,362 bytes) in
1.249 seconds. Sampled aggregate process RSS peaked at approximately 1.13 GiB on
macOS with Chrome 157. This is one host observation, not a hard memory guarantee
or a container sizing result. The 128 MiB V8 heap limit is neither a worker RSS
limit nor a browser memory limit; the original 256 MiB deployment is not certified.

The protocol workflow tests use an authenticated synthetic in-memory backend with
the real stdio/Streamable HTTP transports, operation applier and official renderer.
They cover Library insertion, manual route/label preservation, session isolation,
stale/CAS conflicts, batch atomicity and uncertain-response readback. Run the full
browser-required gate with `EXCALIDASH_RENDER_BROWSER` set to a compatible executable.
`make docker-smoke` checks the hardened runtime when a Docker daemon is available;
that container check remains unverified without one.

## Isolated native backend verification

`scripts/check-backend.mjs` starts a separate real stable ExcaliDash backend using
synthetic data, loopback networking and an isolated SQLite database. This helper
requires Node.js 24.22.1 or later for the pinned upstream backend, a supported
sandboxed Chromium browser, network access for pinned source/dependencies, and the
native build prerequisites for bcrypt/better-sqlite3. This backend-test prerequisite
is separate from the MCP's preserved Node.js 22 container runtime.

The helper pins ExcaliDash `v0.6.7`, commit
`0f9be2d8649be7650e6bee2844739c584fa76c35`, and verifies source archive SHA-256
`a9984fbb59e7710f5a402f1a0fc2b0349b18eeb4474d1753d4e36a73880d59e2`.
It imports the upstream real routes through a fixture and adapts their root paths
to the MCP `/api` seam. MCP calls in this helper use linked in-memory transports;
external stdio/HTTP protocol coverage remains the separate synthetic suite.

Build first, then start a fresh isolated run:

```sh
npm run build
EXCALIDASH_RENDER_BROWSER="/path/to/supported/chromium" node scripts/check-backend.mjs
```

The helper prints its task-owned scratch directory and retains protected evidence
(directory mode 0700, checkpoint mode 0600). It records pending writes before calls
and committed versions/IDs immediately after responses. After a later failure,
resume only the same retained directory; this verifies source pins and saved state
and reuses completed writes instead of creating a second drawing:

```sh
EXCALIDASH_RENDER_BROWSER="/path/to/supported/chromium" node scripts/check-backend.mjs --resume "<owned-scratch-from-previous-output>"
```

An uncertain pending write stops replay and requires saved-state investigation.
The helper shuts down its owned processes and retains the isolated scratch for
review; delete only that named directory when its evidence is no longer needed.
Do not supply a production URL, existing account or production database.

The native stable-backend workflow passed on the same checkpointed drawing across
resume: saved creation and `$ref` bindings, nonempty appState/files preservation,
official rendering, overlap detection, targeted refinement and rerendering, stale
revision rejection, actual backend CAS rejection and invalid-batch atomicity.
No successful create or semantic batch was repeated during recovery. Upstream
stable lacks the patched `library:read` scope, so native Library integration is
not claimed. Library, detailed manual-route/label preservation and session isolation
are covered by the synthetic protocol fixtures. The native result does not certify
Docker, Alpine browser support, a 256 MiB memory budget or production deployment.

The repository skill at [.agents/skills/excalidash/SKILL.md](.agents/skills/excalidash/SKILL.md)
describes architecture, flowchart, targeted editing and messy-layout workflows.
