MCP_IMAGE ?= excalidash-mcp:library-check

.PHONY: check lint test audit docker-smoke
check: lint test audit

lint:
	git diff --check

test:
	npm test

audit:
	npm audit --omit=dev

docker-smoke:
	docker build -t "$(MCP_IMAGE)" .
	docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node "$(MCP_IMAGE)" --input-type=module -e 'import assert from "node:assert/strict"; import { renderLibraryGallery, renderLibraryItem } from "./dist/library-preview.js"; for (const [png, width, height] of [[renderLibraryItem({ id: "synthetic-empty", elements: [] }), 512, 512], [renderLibraryGallery([{ id: "synthetic-empty", elements: [] }]), 640, 800]]) { assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); assert.equal(png.readUInt32BE(16), width); assert.equal(png.readUInt32BE(20), height); assert.ok(png.length <= 1048576); } console.log("Native PNG smoke passed");'

	docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node "$(MCP_IMAGE)" --input-type=module -e 'import assert from "node:assert/strict"; import { renderDrawing } from "./dist/drawing-renderer.js"; await assert.rejects(renderDrawing({version:1,elements:[]}), /Rendering unavailable/); console.log("Browser rendering explicitly unavailable in Alpine");'
