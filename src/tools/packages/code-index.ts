import { safeMutationAnnotations } from "../annotations.js";
import { codeIndexHandler } from "../handlers/code-index.js";
import { defineTool } from "../tool-definition.js";

export const codeIndexTools = [
  defineTool({
    name: "repo_code_index",
    title: "Manage optional code graph index",
    package: "code_index",
    tier: "specialist",
    requiredCapabilities: ["code_intelligence"],
    annotations: safeMutationAnnotations,
    handler: codeIndexHandler
  })
];
