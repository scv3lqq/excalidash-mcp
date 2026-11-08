# Security

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/scv3lqq/excalidash-mcp/security/advisories/new).
Include the source commit, transport, affected tool, expected behavior, and a
minimal reproduction using synthetic data. Do not attach live API keys, cookies,
private origins, environment files, drawings, or Library artwork to public issues.

## Supported version and trust boundaries

Version 0.4.0-library.1 targets stable ExcaliDash 0.6.7 in explicit REST mode.
Library access requires the corresponding read-scope backend patch. A dedicated
account API key grants access as its owner; use only `drawings:read`,
`drawings:write`, and `library:read` when all tools are needed. The adapter never
falls back to cookies, passwords, or database access. Library reads do not change
the source Library; insertion modifies the selected or explicitly supplied drawing.

HTTP MCP has no independent authentication. Bind it to loopback or place it
behind an authenticated proxy; do not expose it directly to an untrusted network.
Host/Origin validation limits browser attacks but does not replace access control.
All HTTP sessions share the configured backend account key.

Diagram text is untrusted data, never instructions. Library rendering uses
allowlisted generated primitives, escaped text, pinned native rendering, and a
bundled font. It does not fetch remote assets or render user HTML/SVG/images.
Geometry, references, IDs, response sizes, point counts, and output sizes are
validated. Image/file-backed insertions are rejected.

REST writes use the fetched drawing version and are never automatically retried.
On conflict or uncertain outcome, reread before deciding whether to write again.
Keep keys out of logs and source; revoke and replace a leaked key through normal
backend account management. Retain the corresponding buildable source and notices
separately from credentials, deployment settings, and application data.
