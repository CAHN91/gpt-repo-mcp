import { describe, expect, test } from "vitest";
import type { RuntimeContext } from "../src/runtime/context.js";
import { gitStatusHandler } from "../src/tools/handlers.js";

describe("tool handler validation boundary", () => {
  test("validates input against the tool contract before using runtime services", async () => {
    let registryUsed = false;
    const context = {
      registry: {
        get() {
          registryUsed = true;
          throw new Error("registry should not be used for invalid input");
        },
        list() {
          registryUsed = true;
          throw new Error("registry should not be used for invalid input");
        }
      }
    } as unknown as RuntimeContext;

    const result = await gitStatusHandler({}, context);
    const structured = result.structuredContent as { error: { code: string } };

    expect(registryUsed).toBe(false);
    expect(result.isError).toBe(true);
    expect(structured.error.code).toBe("VALIDATION_ERROR");
  });
});
