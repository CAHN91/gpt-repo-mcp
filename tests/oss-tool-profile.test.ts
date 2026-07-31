import { describe, expect, test } from "vitest";
import { OSS_TOOL_ORDER } from "../src/tools/oss-tool-profile.js";
import { CANONICAL_TOOL_ORDER } from "../src/tools/registry.js";

describe("OSS tool profile", () => {
  test("explicitly includes the reviewed canonical tool surface", () => {
    expect(OSS_TOOL_ORDER).toEqual(CANONICAL_TOOL_ORDER);
    expect(new Set(OSS_TOOL_ORDER).size).toBe(OSS_TOOL_ORDER.length);
  });
});
