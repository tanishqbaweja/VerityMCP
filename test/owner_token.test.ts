import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOwnerToken } from "../src/config/owner_token.js";

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verity-auth-test-"));
  return {
    home: path.join(root, "home"),
    data: path.join(root, "project", ".verity"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe("Owner credential provisioning", () => {
  it("generates a strong persistent token on a fresh installation", () => {
    const fixture = sandbox();
    try {
      const first = resolveOwnerToken(fixture.data, fixture.home, "");
      assert.match(first, /^[A-Za-z0-9_-]{43}$/);
      const file = path.join(fixture.data, "auth.json");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).ownerToken, first);
      assert.equal(resolveOwnerToken(fixture.data, fixture.home, ""), first);
    } finally {
      fixture.cleanup();
    }
  });

  it("reuses project or legacy credentials without rotation", () => {
    const fixture = sandbox();
    try {
      const legacyFile = path.join(fixture.home, ".verity", "auth.json");
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({ ownerToken: "legacy-owner-token" }));
      assert.equal(resolveOwnerToken(fixture.data, fixture.home, ""), "legacy-owner-token");
      assert.equal(fs.existsSync(path.join(fixture.data, "auth.json")), false);
      fs.mkdirSync(fixture.data, { recursive: true });
      fs.writeFileSync(path.join(fixture.data, "auth.json"), JSON.stringify({ token: "project-owner-token" }));
      assert.equal(resolveOwnerToken(fixture.data, fixture.home, ""), "project-owner-token");
      assert.equal(resolveOwnerToken(fixture.data, fixture.home, "custom-env-token"), "custom-env-token");
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when stored credentials are corrupt", () => {
    const fixture = sandbox();
    try {
      fs.mkdirSync(fixture.data, { recursive: true });
      const file = path.join(fixture.data, "auth.json");
      fs.writeFileSync(file, "not-json");
      assert.throws(() => resolveOwnerToken(fixture.data, fixture.home, ""), /Refusing to run without authentication/);
      assert.equal(fs.readFileSync(file, "utf8"), "not-json");
    } finally {
      fixture.cleanup();
    }
  });
});
