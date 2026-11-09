"use strict";

// This child uses only a verified public source tree and task-owned SQLite fixture.
const path = require("node:path");
const crypto = require("node:crypto");

let server;
let prisma;
let initialized = false;
const reply = (value) => new Promise((resolve, reject) => {
  if (!process.connected) return reject(new Error("Fixture IPC disconnected"));
  process.send(value, error => error ? reject(error) : resolve());
});

async function stop() {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await prisma?.$disconnect();
}

process.on("disconnect", () => { void stop().finally(() => process.exit(0)); });
process.on("message", message => {
  if (message?.action === "stop") { void stop().finally(() => process.exit(0)); return; }
  if (message?.action !== "start" || initialized) return;
  initialized = true;
  void (async () => {
    const root = process.cwd();
    require(path.join(root, "node_modules/ts-node/register/transpile-only"));
    const { PrismaClient } = require(path.join(root, "src/generated/client"));
    const { generateApiKey, serializeApiKeyScopes } = require(path.join(root, "src/auth/apiKeys.ts"));
    const bcrypt = require(path.join(root, "node_modules/bcrypt"));
    prisma = new PrismaClient();
    await prisma.systemConfig.upsert({ where: { id: "default" },
      update: { authEnabled: true, authOnboardingCompleted: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, authOnboardingCompleted: true, registrationEnabled: false },
    });
    const user = await prisma.user.upsert({
      where: { email: "synthetic-backend@example.invalid" }, update: {},
      create: { email: "synthetic-backend@example.invalid", name: "Synthetic fixture user",
        role: "USER", isActive: true,
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10) },
    });
    if (user.role !== "USER" || !user.isActive || user.name !== "Synthetic fixture user") throw new Error("Fixture owner mismatch");
    if (message.drawingId) {
      const drawing = await prisma.drawing.findUnique({ where: { id: message.drawingId } });
      if (!drawing || drawing.userId !== user.id) throw new Error("Fixture drawing owner mismatch");
    }
    // A new pepper invalidates old credentials; bound retained key rows as well.
    await prisma.apiKey.deleteMany({ where: { userId: user.id, name: "Isolated drawing verification" } });
    // The parent has installed its IPC listener before asking us to generate a key.
    const generated = generateApiKey();
    await prisma.apiKey.create({ data: {
      userId: user.id, name: "Isolated drawing verification",
      keyId: generated.keyId, prefix: generated.prefix, tokenHash: generated.tokenHash,
      scopes: serializeApiKeyScopes(["drawings:read", "drawings:write"]),
    } });
    const { httpServer } = require(path.join(root, "src/index.ts"));
    server = httpServer;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    await reply({ ready: true, origin: `http://127.0.0.1:${address.port}`, token: generated.token });
  })().catch(async () => {
    // Do not reflect upstream exception payloads: they may include generated secrets.
    await reply({ error: "Isolated backend seed/start failed; no credentials logged" }).catch(() => {});
    await stop().catch(() => {});
    process.exit(1);
  });
});
