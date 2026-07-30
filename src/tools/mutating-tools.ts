import { toolRegistry } from "./registry.js";
import type { ToolName } from "./contracts.js";

export const MUTATING_TOOL_NAMES = toolRegistry
  .filter((tool) => tool.annotations.readOnlyHint === false)
  .map((tool) => tool.name) satisfies ToolName[];

const MUTATING_TOOL_NAME_SET = new Set<ToolName>(MUTATING_TOOL_NAMES);

export function isMutatingToolName(name: ToolName | string): name is ToolName {
  return MUTATING_TOOL_NAME_SET.has(name as ToolName);
}
