import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ContextMapService } from "../src/services/context-map-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("ContextMapService", () => {
  test("extracts relative TS/JS import edges and reverse dependents for focused paths", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "src", "api.ts"), "export const api = true;\n");
    await writeFile(join(fixture.root, "src", "feature.ts"), [
      "import { api } from './api';",
      "const lazy = import('./lazy');",
      "export const feature = api && lazy;",
      ""
    ].join("\n"));
    await writeFile(join(fixture.root, "src", "feature.test.ts"), "import './feature';\n");

    const result = await new ContextMapService(new PathSandbox(fixture.root)).map({
      focus_paths: ["src/api.ts"]
    });

    expect(result.import_edges).toEqual(expect.arrayContaining([
      { from: "src/feature.ts", to: "src/api.ts", import: "./api" },
      { from: "src/feature.ts", to: "src/lazy.ts", import: "./lazy", unresolved: true }
    ]));
    expect(result.reverse_dependents).toEqual([
      { path: "src/api.ts", dependents: ["src/feature.ts"] }
    ]);
  });

  test("finds affected tests by basename, sibling tests, tests folders, and __tests__", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "src", "__tests__"), { recursive: true });
    await mkdir(join(fixture.root, "tests"), { recursive: true });
    await writeFile(join(fixture.root, "src", "billing.ts"), "export const billing = true;\n");
    await writeFile(join(fixture.root, "src", "billing.test.ts"), "test('billing', () => {});\n");
    await writeFile(join(fixture.root, "src", "__tests__", "billing.spec.ts"), "test('billing', () => {});\n");
    await writeFile(join(fixture.root, "tests", "billing.test.ts"), "test('billing', () => {});\n");

    const result = await new ContextMapService(new PathSandbox(fixture.root)).map({
      focus_paths: ["src/billing.ts"]
    });

    expect(result.affected_tests).toEqual([
      "src/__tests__/billing.spec.ts",
      "src/billing.test.ts",
      "tests/billing.test.ts"
    ]);
  });

  test("classifies generated and dependency paths without scanning their imports", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "src", "uses-dist.ts"), "import '../dist/bundle.js';\n");

    const result = await new ContextMapService(new PathSandbox(fixture.root)).map();

    expect(result.generated_paths).toContain("dist/bundle.js");
    expect(result.dependency_paths).toContain("node_modules/pkg/index.js");
    expect(result.import_edges.some((edge) => edge.from.startsWith("node_modules/"))).toBe(false);
    expect(result.import_edges.some((edge) => edge.from.startsWith("dist/"))).toBe(false);
  });

  test("detects route, component, and entrypoint path signals", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "src", "components"), { recursive: true });
    await mkdir(join(fixture.root, "src", "app", "dashboard"), { recursive: true });
    await writeFile(join(fixture.root, "src", "components", "Button.tsx"), "export function Button() { return null; }\n");
    await writeFile(join(fixture.root, "src", "app", "dashboard", "page.tsx"), "export default function Page() { return null; }\n");
    await writeFile(join(fixture.root, "src", "main.tsx"), "import './app/dashboard/page';\n");
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "^5.0.0" } }));

    const result = await new ContextMapService(new PathSandbox(fixture.root)).map();

    expect(result.entrypoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "package.json", kind: "package" }),
      expect.objectContaining({ path: "src/main.tsx", kind: "runtime" })
    ]));
    expect(result.route_signals).toEqual([
      expect.objectContaining({ path: "src/app/dashboard/page.tsx", route: "/dashboard" })
    ]);
    expect(result.component_signals).toEqual([
      expect.objectContaining({ path: "src/components/Button.tsx", name: "Button" })
    ]);
  });

  test("reports truncation warnings when scan limits are hit", async () => {
    const fixture = await createRepoFixture();

    const result = await new ContextMapService(new PathSandbox(fixture.root), {
      maxTreeEntries: 2
    }).map({
      max_files: 1
    });

    expect(result.truncated).toBe(true);
    expect(result.warnings).toContain("CONTEXT_FILE_LIMIT_REACHED");
  });
});
