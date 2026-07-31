import { describe, expect, test } from "vitest";
import { IgnoreEngine } from "../src/services/ignore-engine.js";

describe("IgnoreEngine", () => {
  test("applies default excludes consistently", () => {
    const engine = new IgnoreEngine();

    expect(engine.isIgnored("node_modules/pkg/index.js")).toBe(true);
    expect(engine.isIgnored(".git/config")).toBe(true);
    expect(engine.isIgnored("src/index.ts")).toBe(false);
  });

  test("applies local tool metadata excludes", () => {
    const engine = new IgnoreEngine();

    expect(engine.isIgnored(".agent-cache/session.json")).toBe(true);
    expect(engine.isIgnored(".codex/cache/state.json")).toBe(true);
  });

  test("blocks sensitive file candidates by default", () => {
    const engine = new IgnoreEngine();

    expect(engine.isSensitiveCandidate(".env")).toBe(true);
    expect(engine.isSensitiveCandidate("config/prod.key")).toBe(true);
    expect(engine.isSensitiveCandidate("src/app.ts")).toBe(false);
  });

  test("always blocks private worker control artifacts and replies", () => {
    const engine = new IgnoreEngine();
    const run = ".chatgpt/codex-runs/2026-07-13T170000Z-private";

    expect(engine.isSensitiveCandidate(`${run}/runner.session.json`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run}/runner.attempt.json`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run}/runner.lock.json`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run}/runner.lock.json.replace`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run}/runner.session.json.tmp-123-456-abcdef`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run}/interactions/turn-0001.reply.json`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run.toUpperCase()}/RUNNER.SESSION.JSON`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run}/InTeRaCtIoNs/TuRn-0001.RePlY.JsOn`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run.replaceAll("/", "\\")}\\RuNnEr.AtTeMpT.JsOn`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run}/RUNNER.LOCK.JSON.TMP-123-456-AbCdEf`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run}/RuNnEr.LoCk.JsOn`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run}/RUNNER.LOCK.JSON.REPLACE`)).toBe(true);
    expect(engine.isSensitiveCandidate(`${run}/interactions/turn-0001.question.json`)).toBe(false);
    expect(engine.isSensitiveCandidate(`${run}/runner.status.json`)).toBe(false);
  });

  test("allows ordinary code docs and tests that mention secret or credential", () => {
    const engine = new IgnoreEngine();

    expect(engine.isSensitiveCandidate("src/services/secret-scanner.ts")).toBe(false);
    expect(engine.isSensitiveCandidate("docs/secret-management.md")).toBe(false);
    expect(engine.isSensitiveCandidate("tests/credential-flow.test.ts")).toBe(false);
    expect(engine.isSensitiveCandidate("src/auth/credentialStore.ts")).toBe(false);
  });

  test("still blocks directories exactly named secrets or credentials", () => {
    const engine = new IgnoreEngine();

    expect(engine.isSensitiveCandidate("secrets/foo.txt")).toBe(true);
    expect(engine.isSensitiveCandidate("credentials/foo.txt")).toBe(true);
    expect(engine.isSensitiveCandidate("src/secrets/foo.txt")).toBe(true);
    expect(engine.isSensitiveCandidate("src/credentials/foo.txt")).toBe(true);
  });

  test("exempts only exact public env template names from sensitive candidates", () => {
    const engine = new IgnoreEngine();

    expect(engine.isSensitiveCandidate(".env.example")).toBe(false);
    expect(engine.isSensitiveCandidate(".env.sample")).toBe(false);
    expect(engine.isSensitiveCandidate(".env.template")).toBe(false);
    expect(engine.isSensitiveCandidate("example.env")).toBe(false);

    expect(engine.isSensitiveCandidate(".env")).toBe(true);
    expect(engine.isSensitiveCandidate(".env.local")).toBe(true);
    expect(engine.isSensitiveCandidate(".env.production")).toBe(true);
    expect(engine.isSensitiveCandidate(".env.anything")).toBe(true);
    expect(engine.isSensitiveCandidate("nested/.env.example")).toBe(true);
  });
});
