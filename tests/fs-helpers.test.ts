import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  atomicWriteFile,
  atomicWriteJson,
  isAlreadyExistsError,
  isNotFoundError,
  writeExclusiveJson
} from "../src/runtime/fs-helpers.js";

describe("fs helpers", () => {
  test("detects common filesystem error codes", () => {
    expect(isNotFoundError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(true);
    expect(isAlreadyExistsError(Object.assign(new Error("exists"), { code: "EEXIST" }))).toBe(true);
    expect(isNotFoundError(Object.assign(new Error("exists"), { code: "EEXIST" }))).toBe(false);
    expect(isAlreadyExistsError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(false);
  });

  test("writes JSON atomically without leaving temp files", async () => {
    const root = await mkdtemp(join(tmpdir(), "fs-helpers-"));
    const path = join(root, "nested", "value.json");

    await atomicWriteJson(path, { ok: true });

    await expect(readFile(path, "utf8")).resolves.toBe(`${JSON.stringify({ ok: true }, null, 2)}\n`);
    await expect(readdir(join(root, "nested"))).resolves.toEqual(["value.json"]);
  });

  test("writes files atomically and refuses exclusive JSON overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "fs-helpers-exclusive-"));
    const filePath = join(root, "nested", "file.txt");
    const jsonPath = join(root, "nested", "lock.json");

    await atomicWriteFile(filePath, Buffer.from("content"));
    await writeExclusiveJson(jsonPath, { owner: "first" });

    await expect(readFile(filePath, "utf8")).resolves.toBe("content");
    await expect(readFile(jsonPath, "utf8")).resolves.toBe(`${JSON.stringify({ owner: "first" }, null, 2)}\n`);
    await expect(writeExclusiveJson(jsonPath, { owner: "second" })).rejects.toSatisfy(isAlreadyExistsError);
  });
});
