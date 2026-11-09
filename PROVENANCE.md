# MCP REST adapter provenance and licensing

This fork adapts ExcaliDash MCP to the stable ExcaliDash 0.6.7 REST API.
It does not install a historical backend or runtime.

## Sources and licenses

- `agent/applyOps.ts`, `agent/batchRefs.ts`, `agent/elementFactory.ts`,
  `agent/layoutOps.ts`, `agent/scene.ts`, `agent/opSchemas.ts`, and
  `agent/summary.ts` are copied from ExcaliDash commit
  `a6969c94d158e487bb0225c49cb39429223f08e8`, paths `backend/src/agent/`.
  Their original AGPL-3.0 license is preserved verbatim in `LICENSE`.
  The combined work is distributed as AGPL-3.0-only; upstream MIT portions
  retain their original notice in `LICENSE-MIT`.
  Source: https://github.com/zimengxiong/ExcaliDash/tree/a6969c94d158e487bb0225c49cb39429223f08e8/backend/src/agent
- Vendored changes: relative import specifiers gain `.js` for NodeNext;
  array accesses proven in bounds gain non-null assertions in `elementFactory`,
  `layoutOps`, and `summary`; one text-line callback gains a string annotation.
  Scene binding updates now affect only actual geometry dependencies and preserve
  unrelated routes and labels. Shared operation schemas also validate MCP input.
- `excalidash.ts` and `index.ts` adapt ExcaliDash MCP commit
  `68d2119f12f2578f7996d68a518608d87e83a3bd`, originally MIT licensed.
  The original MIT copyright and permission notice is reproduced below.
  Server initialization instructions identify corresponding source and document
  REST compatibility semantics. `MCP_SOURCE_URL` optionally selects a validated
  HTTPS source location for both stdio and HTTP entry points.
- `rest.ts`, `rest.test.ts`, and the minimal `security.ts` text sanitizer are
  adapter additions distributed with this combined AGPL-3.0-only source.
  No backend authentication, server routes, database code, or runtime packages
  are imported.

## Corresponding source offer

Every MCP initialization returns the source offer through server instructions.
The default is https://github.com/scv3lqq/excalidash-mcp. An operator may set
`MCP_SOURCE_URL` to an HTTPS location containing the complete corresponding
buildable source for the running version. Invalid or non-HTTPS values fail
at startup. Existing `createServer(client, initialDrawingId?)` callers retain
the default; a third `sourceUrl` argument overrides it.

The deployment operator must publish complete corresponding buildable source,
including upstream MCP source, the adapter and notices, pinned package
manifests, TypeScript configuration, Dockerfile and build instructions. Never
include environment files, credentials, account data, drawing data, deployment
configuration, private inventory, or unrelated source repositories. The archive
must be installed and checked before enabling the adapted service.

This file records the source contract; it does not assert that publication or
production deployment has happened.

## REST compatibility semantics

Semantic batches use the stable full-scene GET and version-guarded PUT API.
Only `elements` and the fetched integer `version` are sent by updates.
`clientBatchId` is correlation only, never durable idempotency. After uncertain
network outcomes, reread the drawing before deciding on a new batch. Version
conflicts require a fresh read; writes are never automatically retried.
Snapshot restoration is unavailable to drawing-scoped API keys in this mode.

## Original MCP MIT notice

```text
MIT License

Copyright (c) 2026 Chaehyeon Lee

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```


## Official drawing renderer additions

Stable compatibility was checked against ExcaliDash `v0.6.7`, commit
`0f9be2d8649be7650e6bee2844739c584fa76c35`; its frontend lock pins
`@excalidraw/excalidraw` 0.18.1. Source:
https://github.com/zimengxiong/ExcaliDash/tree/v0.6.7 .

The drawing renderer uses official Excalidraw 0.18.1 `exportToCanvas`,
`exportToSvg` (region crops), and `getCommonBounds` in a sandboxed browser, with the
package's locally hosted fonts. Excalidraw is MIT licensed. Retained renderer and
individual font notices are in `assets/excalidraw-NOTICES.txt`, including Excalifont
and Xiaolai OFL notices and the older Liberation GPLv2/font-exception notice.
Font licenses are recorded individually rather than assigned the renderer's MIT
license. Preserve these notices and copied assets with corresponding buildable source.
Official source:
https://github.com/excalidraw/excalidraw/tree/v0.18.1 .

`drawing-analysis.ts`, `drawing-renderer.ts`, `render-worker.ts`,
`renderer-entry.ts`, the renderer build script and workflow tests are additions
to this combined AGPL-3.0-only source. The official scene exporter is distinct
from the approximate resvg Library preview renderer. Browser memory is outside
the worker JavaScript heap cap; no hard host memory guarantee or Alpine/256 MiB
container certification is asserted. Protocol fixtures use synthetic mocked
backend storage and real stdio/HTTP, not production accounts.

The separate native verifier, `scripts/check-backend.mjs` with
`scripts/backend-fixture.cjs`, downloads the stable source commit above and checks
archive SHA-256 `a9984fbb59e7710f5a402f1a0fc2b0349b18eeb4474d1753d4e36a73880d59e2`.
It runs real upstream routes with isolated synthetic SQLite data and linked
in-memory MCP transports. Its successful checkpointed resume verified saved-scene
render/refine/readback and backend revision semantics without repeating committed
creates. This is distinct from the mocked protocol suite. Native Library scope
integration is not claimed because unpatched stable lacks `library:read`; no
production backend, real accounts or private data are included in these fixtures.
