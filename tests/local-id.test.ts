import { describe, expect, test } from "vitest";
import {
  formatLocalHandoffMinuteTimestamp,
  formatUtcCodexRunTimestamp,
  formatUtcWorkSessionTimestamp,
  slugifyLabel
} from "../src/services/local-id.js";

describe("local id helpers", () => {
  test("slugifies labels consistently with fallbacks and optional max length", () => {
    expect(slugifyLabel("API keys: fix & polish", "fallback")).toBe("api-keys-fix-polish");
    expect(slugifyLabel("Åtgärda déjà vu", "fallback")).toBe("atgarda-deja-vu");
    expect(slugifyLabel("!!!", "fallback")).toBe("fallback");
    expect(slugifyLabel("Long label with trailing separator", "fallback", 16)).toBe("long-label-with");
  });

  test("formats local artifact timestamps for existing run id conventions", () => {
    const utcDate = new Date(Date.UTC(2026, 5, 4, 8, 15, 0, 0));
    const localDate = new Date(2026, 5, 4, 8, 15, 0, 0);

    expect(formatUtcCodexRunTimestamp(utcDate)).toBe("2026-06-04T081500Z");
    expect(formatUtcWorkSessionTimestamp(utcDate)).toBe("20260604-081500");
    expect(formatLocalHandoffMinuteTimestamp(localDate)).toBe("2026-06-04-0815");
  });
});
