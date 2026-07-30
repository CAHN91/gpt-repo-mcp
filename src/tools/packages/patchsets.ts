import { nonDestructiveMutationAnnotations, readOnlyAnnotations, writeAnnotations } from "../annotations.js";
import { applyPatchsetHandler, preparePatchsetHandler, reviewPatchsetHandler, rollbackPatchsetHandler } from "../handlers/patchsets.js";
import { defineTool } from "../tool-definition.js";

export const patchsetTools = [
  defineTool({ name: "repo_prepare_patchset", title: "Prepare patchset", package: "patchsets", tier: "specialist", annotations: nonDestructiveMutationAnnotations, handler: preparePatchsetHandler }),
  defineTool({ name: "repo_apply_patchset", title: "Apply patchset", package: "patchsets", tier: "specialist", annotations: writeAnnotations, handler: applyPatchsetHandler }),
  defineTool({ name: "repo_review_patchset", title: "Review patchset", package: "patchsets", tier: "specialist", annotations: readOnlyAnnotations, handler: reviewPatchsetHandler }),
  defineTool({ name: "repo_rollback_patchset", title: "Rollback patchset", package: "patchsets", tier: "specialist", annotations: writeAnnotations, handler: rollbackPatchsetHandler })
];
