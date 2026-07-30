import { describe, expect, test } from "vitest";
import { buildDelegationProductBindingV3, normalizeDelegationTaskV3 } from "../src/services/delegation-v3-normalizer.js";
import { auditDelegationTaskV3 } from "../src/services/delegation-v3-audit.js";
import {
  overspecifiedProductTaskInput,
  productSelection,
  productTaskInput,
  securityTaskInput,
  technicalTaskInput
} from "./fixtures/delegation-v3-fixtures.js";

describe("Delegation v3 audit", () => {
  test("passes grounded product and technical tasks without heuristic warnings", () => {
    for (const input of [productTaskInput("product_slice"), productTaskInput("product_correction"), technicalTaskInput()]) {
      const task = normalizeDelegationTaskV3(input);
      const binding = "product_alignment" in task
        ? buildDelegationProductBindingV3(task, productSelection())
        : buildDelegationProductBindingV3(task);
      expect(auditDelegationTaskV3(task, binding, "enforce")).toEqual({
        verdict: "passed",
        mode: "enforce",
        product_grounding: "product_alignment" in task ? "complete" : "not_required",
        closed_world_risk: "low",
        overspecification_risk: "low",
        signals: [],
        warnings: []
      });
    }
  });

  test("accepts security and migration precision when it is confined to declared contracts", () => {
    const task = normalizeDelegationTaskV3(securityTaskInput());
    const audit = auditDelegationTaskV3(task, buildDelegationProductBindingV3(task), "enforce");

    expect(audit).toMatchObject({
      verdict: "passed",
      product_grounding: "not_required",
      closed_world_risk: "low",
      overspecification_risk: "low",
      warnings: []
    });
    expect(audit.signals).toEqual([
      expect.stringMatching(/^security\/migration precision confined to declared contracts: \d+ signal\(s\) accepted$/)
    ]);
  });

  test("warns but does not block an overspecified request even in enforce mode", () => {
    const task = normalizeDelegationTaskV3(overspecifiedProductTaskInput());
    const audit = auditDelegationTaskV3(task, buildDelegationProductBindingV3(task, productSelection()), "enforce");

    expect(audit).toMatchObject({
      verdict: "passed_with_warnings",
      product_grounding: "complete",
      closed_world_risk: "high",
      overspecification_risk: "high",
      warnings: ["DELEGATION_CLOSED_WORLD_RISK", "DELEGATION_OVERSPECIFICATION_RISK"]
    });
    expect(audit.signals).toEqual(expect.arrayContaining([
      expect.stringMatching(/^closed-world wording detected/),
      expect.stringMatching(/^implementation-prescription wording detected/),
      expect.stringMatching(/^high exact-path density/),
      expect.stringMatching(/^high internal-symbol density/),
      expect.stringMatching(/^numbered implementation sequence detected/),
      expect.stringMatching(/^task input contains 1 code fence/),
      "high starting-point count: 13",
      "high acceptance-criterion count: 23"
    ]));
  });

  test("blocks missing product grounding only in enforce mode", () => {
    const task = normalizeDelegationTaskV3(productTaskInput());
    const missingBinding = { kind: "not_required" as const };

    expect(auditDelegationTaskV3(task, missingBinding, "advisory")).toMatchObject({
      verdict: "passed_with_warnings",
      product_grounding: "missing",
      warnings: ["DELEGATION_PRODUCT_GROUNDING_MISSING"]
    });
    expect(auditDelegationTaskV3(task, missingBinding, "enforce")).toMatchObject({
      verdict: "blocked",
      product_grounding: "missing",
      warnings: ["DELEGATION_PRODUCT_GROUNDING_MISSING"]
    });
  });

  test("is deterministic and does not retain RegExp state between calls", () => {
    const task = normalizeDelegationTaskV3(overspecifiedProductTaskInput());
    const binding = buildDelegationProductBindingV3(task, productSelection());
    const first = auditDelegationTaskV3(task, binding, "advisory");
    const second = auditDelegationTaskV3(task, binding, "advisory");
    expect(second).toEqual(first);
  });
});
