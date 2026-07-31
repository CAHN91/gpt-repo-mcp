export type DelegationRuntimeBudget = {
  requested_max_runtime_ms: number | null;
  effective_max_runtime_ms: number;
  active_runtime_ms: number;
  remaining_runtime_ms: number;
};

export function resolveEffectiveMaxRuntimeMs(
  repositoryMaxRuntimeMs: number,
  requestedMaxRuntimeMs?: number,
  persistedMaxRuntimeMs?: number
): number {
  return Math.min(
    repositoryMaxRuntimeMs,
    requestedMaxRuntimeMs ?? repositoryMaxRuntimeMs,
    persistedMaxRuntimeMs ?? repositoryMaxRuntimeMs
  );
}

export function describeAgentRuntimeBudget(
  repositoryMaxRuntimeMs: number,
  requestedMaxRuntimeMs: number | undefined,
  activeRuntimeMs: number,
  persistedMaxRuntimeMs?: number
): DelegationRuntimeBudget {
  const effectiveMaxRuntimeMs = resolveEffectiveMaxRuntimeMs(
    repositoryMaxRuntimeMs,
    requestedMaxRuntimeMs,
    persistedMaxRuntimeMs
  );
  const normalizedActiveRuntimeMs = Math.max(0, Math.trunc(activeRuntimeMs));
  return {
    requested_max_runtime_ms: requestedMaxRuntimeMs ?? null,
    effective_max_runtime_ms: effectiveMaxRuntimeMs,
    active_runtime_ms: normalizedActiveRuntimeMs,
    remaining_runtime_ms: Math.max(0, effectiveMaxRuntimeMs - normalizedActiveRuntimeMs)
  };
}
