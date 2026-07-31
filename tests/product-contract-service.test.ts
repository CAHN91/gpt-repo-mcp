import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ProductContract } from "../src/contracts/product-contract.contract.js";
import {
  MAX_PRODUCT_CONTRACT_BYTES,
  PRODUCT_CONTRACT_PATH,
  ProductContractService,
  productReviewRequired
} from "../src/services/product-contract-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

function validContract(overrides: Partial<ProductContract> = {}): ProductContract {
  return {
    schema_version: 1,
    product: { name: "Demo Product", purpose: "Help an operator resolve exceptions safely." },
    primary_users: [{
      id: "operator",
      role: "Operations coordinator",
      technical_level: "Non-technical",
      work_context: "Works under time pressure in an existing operational workflow."
    }],
    jobs_to_be_done: [{ id: "resolve-exception", statement: "Understand an exception and take the correct next action." }],
    must_reduce: ["Manual comparison"],
    must_not_become: ["A technical analysis workspace"],
    experience_principles: ["Decision before internal system detail"],
    canonical_docs: ["docs/guide.md"],
    governance: {
      mode: "advisory",
      product_review_required_for: ["product_slice", "product_correction"],
      checkpoint_every_root_runs: 5
    },
    ...overrides
  };
}

async function writeContract(root: string, value: unknown): Promise<void> {
  await writeFile(join(root, PRODUCT_CONTRACT_PATH), `${JSON.stringify(value, null, 2)}\n`);
}

describe("ProductContractService", () => {
  test("dogfoods the committed GPT Repo MCP product contract", async () => {
    const root = process.cwd();
    const result = await new ProductContractService(new PathSandbox(root)).load();

    expect(result.status).toBe("configured");
    if (result.status !== "configured") return;
    expect(result.contract.product.name).toBe("GPT Repo MCP");
    expect(result.contract_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.canonical_documents.map(({ path }) => path)).toEqual(result.contract.canonical_docs);
  });

  test("returns normalized context and stable canonical hashes independent of JSON formatting", async () => {
    const fixture = await createRepoFixture();
    const first = validContract({ product: { name: "  Demo Product  ", purpose: "  Help an operator resolve exceptions safely.  " } });
    await writeContract(fixture.root, first);
    const service = new ProductContractService(new PathSandbox(fixture.root));
    const firstResult = await service.load();

    expect(firstResult.status).toBe("configured");
    if (firstResult.status !== "configured") return;
    expect(firstResult.contract.product.name).toBe("Demo Product");

    await writeFile(join(fixture.root, PRODUCT_CONTRACT_PATH), JSON.stringify(validContract()));
    const secondResult = await service.load();
    expect(secondResult.status).toBe("configured");
    if (secondResult.status !== "configured") return;
    expect(secondResult.contract_sha256).toBe(firstResult.contract_sha256);

    const selection = await service.select({ primary_user_id: "operator", job_ids: ["resolve-exception"] });
    const secondSelection = await service.select({ primary_user_id: "operator", job_ids: ["resolve-exception"] });
    expect(selection.snapshot.primary_user.id).toBe("operator");
    expect(selection.snapshot_sha256).toBe(secondSelection.snapshot_sha256);
  });

  test("returns a visible non-fatal missing state without inventing product facts", async () => {
    const fixture = await createRepoFixture();
    const result = await new ProductContractService(new PathSandbox(fixture.root)).load();

    expect(result).toMatchObject({
      status: "missing",
      source_path: PRODUCT_CONTRACT_PATH,
      diagnostic: { code: "PRODUCT_CONTRACT_MISSING" }
    });
    expect(result).not.toHaveProperty("contract");
  });

  test("reports malformed, unsupported, truncated, and credential-bearing contracts with stable diagnostics", async () => {
    const fixture = await createRepoFixture();
    const service = new ProductContractService(new PathSandbox(fixture.root));

    await writeFile(join(fixture.root, PRODUCT_CONTRACT_PATH), "{not json\n");
    await expect(service.load()).resolves.toMatchObject({ status: "invalid", diagnostic: { code: "PRODUCT_CONTRACT_MALFORMED" } });

    await writeContract(fixture.root, { ...validContract(), schema_version: 2 });
    await expect(service.load()).resolves.toMatchObject({ status: "invalid", diagnostic: { code: "PRODUCT_CONTRACT_UNSUPPORTED" } });

    await writeFile(join(fixture.root, PRODUCT_CONTRACT_PATH), "x".repeat(MAX_PRODUCT_CONTRACT_BYTES + 1));
    await expect(service.load()).resolves.toMatchObject({ status: "invalid", diagnostic: { code: "PRODUCT_CONTRACT_TRUNCATED" } });

    const value = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const sample = ["OPENAI", "API", "KEY"].join("_") + "=" + value;
    const blocked = validContract({ product: { name: "Demo Product", purpose: sample } });
    await writeContract(fixture.root, blocked);
    await expect(service.load()).resolves.toMatchObject({ status: "invalid", diagnostic: { code: "PRODUCT_CONTRACT_SECRET_BLOCKED" } });
  });

  test("rejects duplicate IDs, unsafe canonical paths, missing canonical documents, and symlink contracts", async () => {
    const fixture = await createRepoFixture();
    const service = new ProductContractService(new PathSandbox(fixture.root));

    const user = validContract().primary_users[0]!;
    await writeContract(fixture.root, validContract({ primary_users: [user, user] }));
    await expect(service.load()).resolves.toMatchObject({ status: "invalid", diagnostic: { code: "PRODUCT_CONTRACT_MALFORMED" } });

    await writeContract(fixture.root, validContract({ canonical_docs: ["../outside.md"] }));
    await expect(service.load()).resolves.toMatchObject({ status: "invalid", diagnostic: { code: "PRODUCT_CONTRACT_UNSAFE" } });

    await writeContract(fixture.root, validContract({ canonical_docs: ["docs/missing.md"] }));
    await expect(service.load()).resolves.toMatchObject({ status: "invalid", diagnostic: { code: "PRODUCT_CONTRACT_CANONICAL_DOC_INVALID" } });

    const target = join(fixture.root, "docs", "real-product-contract.json");
    await writeFile(target, `${JSON.stringify(validContract(), null, 2)}\n`);
    await rm(join(fixture.root, PRODUCT_CONTRACT_PATH));
    await symlink(target, join(fixture.root, PRODUCT_CONTRACT_PATH));
    await expect(service.load()).resolves.toMatchObject({ status: "invalid", diagnostic: { code: "PRODUCT_CONTRACT_UNSUPPORTED" } });
  });

  test("rejects unknown selected user or job IDs and exposes explicit governance mode", async () => {
    const fixture = await createRepoFixture();
    await writeContract(fixture.root, validContract({
      governance: {
        mode: "enforce",
        product_review_required_for: ["product_slice"],
        checkpoint_every_root_runs: 3
      }
    }));
    const service = new ProductContractService(new PathSandbox(fixture.root));
    const loaded = await service.requireConfigured();

    expect(loaded.contract.governance.mode).toBe("enforce");
    expect(productReviewRequired(loaded.contract, "product_slice")).toBe(true);
    expect(productReviewRequired(loaded.contract, "product_correction")).toBe(false);
    await expect(service.select({ primary_user_id: "missing-user", job_ids: ["resolve-exception"] })).rejects.toMatchObject({
      code: "PRODUCT_CONTRACT_SELECTION_INVALID"
    });
    await expect(service.select({ primary_user_id: "operator", job_ids: ["missing-job"] })).rejects.toMatchObject({
      code: "PRODUCT_CONTRACT_SELECTION_INVALID"
    });
  });
});
