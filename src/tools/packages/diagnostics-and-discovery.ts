import { readOnlyAnnotations } from "../annotations.js";
import { decisionMemoryHandler, failureDiagnoseHandler, semanticReviewHandler, taskInventoryHandler } from "../handlers/diagnostics-and-discovery.js";
import { defineTool } from "../tool-definition.js";

export const diagnosticAndDiscoveryTools = [
  defineTool({ name: "repo_failure_diagnose", title: "Diagnose repository failure evidence", package: "diagnostics_and_discovery", tier: "specialist", annotations: readOnlyAnnotations, handler: failureDiagnoseHandler }),
  defineTool({ name: "repo_semantic_review", title: "Review semantic change risks", package: "diagnostics_and_discovery", tier: "specialist", annotations: readOnlyAnnotations, handler: semanticReviewHandler }),
  defineTool({ name: "repo_task_inventory", title: "Inventory repository tasks", package: "diagnostics_and_discovery", tier: "specialist", annotations: readOnlyAnnotations, handler: taskInventoryHandler }),
  defineTool({ name: "repo_decision_memory", title: "Extract decision memory", package: "diagnostics_and_discovery", tier: "specialist", annotations: readOnlyAnnotations, handler: decisionMemoryHandler })
];
