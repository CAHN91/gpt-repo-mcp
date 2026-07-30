import { describe, expect, test } from "vitest";
import { parseFailureDiagnostics } from "../src/services/failure-diagnostic-parser.js";

describe("parseFailureDiagnostics", () => {
  test("normalizes supported compiler, linter, test, and stack formats", () => {
    const root = "/workspace/repo";
    const cases: Array<{ text: string; tool: string; path: string; line?: number }> = [
      { text: "src/app.ts(4,9): error TS2345: Invalid argument", tool: "typescript", path: "src/app.ts", line: 4 },
      { text: "src/app.ts:8:3 error Unexpected any @typescript-eslint/no-explicit-any", tool: "eslint", path: "src/app.ts", line: 8 },
      { text: "FAIL tests/app.test.ts > app > rejects invalid input", tool: "vitest", path: "tests/app.test.ts" },
      { text: "FAIL tests/app.test.ts > app rejects invalid input\nTest Suites: 1 failed, 1 total", tool: "jest", path: "tests/app.test.ts" },
      { text: "FAILED tests/test_app.py > test_rejects\ntests/test_app.py:12: AssertionError", tool: "pytest", path: "tests/test_app.py" },
      { text: "at execute (/workspace/repo/src/app.ts:14:7)", tool: "node", path: "src/app.ts", line: 14 },
      { text: "File \"/workspace/repo/src/app.py\", line 19, in execute", tool: "python", path: "src/app.py", line: 19 }
    ];

    for (const item of cases) {
      expect(parseFailureDiagnostics(item.text, "validation", ".chatgpt/validation/test/result.json", root))
        .toContainEqual(expect.objectContaining({ tool: item.tool, path: item.path, ...(item.line ? { line: item.line } : {}) }));
    }
  });

  test("drops absolute stack paths outside the approved repository root", () => {
    const diagnostics = parseFailureDiagnostics("at execute (/outside/private/app.ts:4:2)", "dev_harness", ".chatgpt/dev-harness/debug/report.json", "/workspace/repo");
    expect(diagnostics[0]?.tool).toBe("node");
    expect(diagnostics[0]?.path).toBeUndefined();
  });
});
