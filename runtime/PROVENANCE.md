# Browser confinement policy provenance

These policies accompany the optional `Dockerfile.browser` image. They do not
change the Alpine runtime or the host's global security policy.

## Playwright seccomp

`seccomp.upstream.json` is an unmodified copy of Microsoft's official
[Playwright Docker profile](https://github.com/microsoft/playwright/blob/84e2bdcaa5a6e4a9e8afcbe8b1bca4ff8a8cb69a/utils/docker/seccomp_profile.json),
commit `84e2bdcaa5a6e4a9e8afcbe8b1bca4ff8a8cb69a`.
Its SHA-256 is
`cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`.
`seccomp.json` retains that complete parsed profile and inserts exactly one
unconditional `SCMP_ACT_ALLOW` rule for `chroot` at `syscalls[1]`, with empty
`args`, `includes`, and `excludes`. Its SHA-256 is
`d51db786ddbe1e69133120500c852e733889230bfa7fbe1377c4b44b9fc42a92`.
This permits Chromium's chroot within its unprivileged user namespace when the
container drops all initial capabilities; the original conditional rule requires
`CAP_SYS_CHROOT` in the container's capability set. Kernel capability and filesystem
checks still apply. No capability is added, and all original rules, namespace
permissions and default-deny filtering remain. The only byte differences from the
upstream JSON are the inserted rule. Upstream license: [LICENSE-PLAYWRIGHT](LICENSE-PLAYWRIGHT),
Apache-2.0, retained verbatim from the same commit.

## Moby AppArmor

`moby-apparmor-template.go` is the unmodified
[Moby default container template](https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/apparmor/template.go),
commit `4b8214fc4971e06172938a1f1554ccff6647ee80`.
Its SHA-256 is
`7da15d81aa5c507f5002b844fdc49a969904681447a2cc29222bd6cbe797163b`.
Upstream license: [LICENSE-MOBY](LICENSE-MOBY), Apache-2.0, retained verbatim from
the same commit. Copyright and SPDX notices remain in both source and policy.

`apparmor.profile` materializes that template with profile/peer name
`excalidash-mcp-browser`, daemon peer `unconfined` (the usual Docker daemon),
`tunables/global`, and `abstractions/base`. The only policy adaptations are ABI
`4.0`, `userns,` for Chromium's unprivileged namespace sandbox, and `network unix,`
for explicit Unix socket access with that ABI. All upstream mount, proc, sys and
socket-family denials and signal/ptrace peer restrictions remain. A daemon peer
allowed to send stop signals does not make the container profile unconfined.

Load only this named policy after reviewing and parsing it on the target Linux
host. Preserve an existing different policy with the same name instead of replacing
it. Never substitute an unconfined profile or disable the Chromium sandbox.
