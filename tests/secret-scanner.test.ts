import { describe, expect, test } from "vitest";
import { SecretScanner } from "../src/services/secret-scanner.js";
import { redactSensitiveText as redactResultText } from "../src/runtime/result-envelope.js";

const scanner = new SecretScanner();
const joined = (...parts: string[]): string => parts.join("");
const fakeGitHubPat = joined("ghp_", "0123456789", "abcdefghijklmnopqrstuvwxyz");
const fakeBearer = joined("bearer-token-", "0123456789");

describe("credential detection and redaction", () => {
  test.each([
    ["OpenAI key", joined("sk", "-proj-", "0123456789", "abcdefghijklmnop")],
    ["GitHub PAT", fakeGitHubPat],
    ["fine-grained GitHub PAT", joined("github_pat_", "01ABCDEF23456789_", "abcdefghijklmnopqrstuvwxyz")],
    ["AWS access key", joined("AWS_ACCESS_KEY_ID=", "AKIA", "0123456789ABCDEF")],
    ["Slack token", joined("xoxb-", "123456789012-", "abcdefghijklmnopqrstuvwx")],
    ["Google API key", joined("AIzaSyD", "0123456789", "abcdefghijklmnopqrstuv")],
    ["JSON access token", JSON.stringify({ access_token: joined("gho_", "0123456789", "abcdefghijklmnopqrstuvwxyz") })],
    ["YAML client secret", joined("client_secret: ", "client-secret-", "0123456789")],
    ["Bearer header", `Authorization: Bearer ${fakeBearer}`],
    [
      "private key block",
      "-----BEGIN PRIVATE KEY-----\nZmFrZS1wcml2YXRlLWtleQ==\n-----END PRIVATE KEY-----"
    ]
  ])("detects %s", (_label, value) => {
    expect(scanner.hasSecretValue(value)).toBe(true);
  });

  test.each([
    "OPENAI_API_KEY=replace-me",
    "token=your-api-key-here",
    "token=[REDACTED_SECRET]",
    "token_count=42",
    "public_key=used-for-signature-verification",
    "Use sk-... only as a placeholder.",
    "Authorization: Bearer"
  ])("does not flag placeholder or non-secret text: %s", (value) => {
    expect(scanner.hasSecretValue(value)).toBe(false);
  });

  test("redacts only credential values while preserving useful labels", () => {
    const input = `request failed: ${JSON.stringify({ access_token: fakeGitHubPat })}`;
    const expected = "request failed: {\"access_token\":\"[REDACTED_SECRET]\"}";

    expect(scanner.redact(input)).toBe(expected);
    expect(redactResultText(input)).toBe(expected);
  });

  test("redacts bearer values and complete private key blocks", () => {
    const input = [
      `Authorization: Bearer ${fakeBearer}`,
      "-----BEGIN PRIVATE KEY-----",
      "ZmFrZS1wcml2YXRlLWtleQ==",
      "-----END PRIVATE KEY-----"
    ].join("\n");
    const redacted = scanner.redact(input);

    expect(redacted).toContain("Authorization: Bearer [REDACTED_SECRET]");
    expect(redacted).not.toContain(fakeBearer);
    expect(redacted).not.toContain("ZmFrZS1wcml2YXRlLWtleQ==");
  });

  test("detects only newly introduced credential values", () => {
    const existing = `Authorization: Bearer ${fakeBearer}`;

    expect(scanner.hasNewSecretValue(existing, existing)).toBe(false);
    expect(scanner.hasNewSecretValue(
      existing,
      `Authorization: Bearer ${joined("different-token-", "9876543210")}`
    )).toBe(true);
  });
});
