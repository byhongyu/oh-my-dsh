import {
  CustomAgentSetupSchema,
  type AgentSetup,
  type CapabilityPack,
  type CustomAgentSetup,
} from "@oh-my-dsh/schema";

import {
  resolveCustomSetup,
  resolveSetup,
  semanticDiff,
  type ResolvedSetup,
  type SemanticDiff,
} from "./index.js";

export type ForkUpdatePlan =
  | {
      conflicts: [];
      candidate: CustomAgentSetup;
      resolved: ResolvedSetup;
      parentChanges: SemanticDiff;
    }
  | {
      conflicts: string[];
      parentChanges: SemanticDiff;
    };

export function planForkUpdate(
  fork: CustomAgentSetup,
  previousParent: AgentSetup,
  nextParent: AgentSetup,
  capabilities: readonly CapabilityPack[],
): ForkUpdatePlan {
  if (
    previousParent.metadata.id !== nextParent.metadata.id ||
    fork.extends.id !== previousParent.metadata.id
  ) {
    throw new Error("fork update parent identity mismatch");
  }
  if (fork.extends.version !== previousParent.metadata.version) {
    throw new Error(
      `fork update starts from ${fork.extends.version}, not previous parent ${previousParent.metadata.version}`,
    );
  }

  const before = resolveSetup(previousParent, capabilities);
  const after = resolveSetup(nextParent, capabilities);
  const parentChanges = semanticDiff(before, after);
  const nextWorkflowIds = new Set(
    after.workflows.map((workflow) => workflow.id),
  );
  const conflicts: string[] = [];
  for (const id of [
    ...(fork.overrides.workflows?.enable ?? []),
    ...(fork.overrides.workflows?.disable ?? []),
  ]) {
    if (!nextWorkflowIds.has(id))
      conflicts.push(`overridden workflow ${id} no longer exists upstream`);
  }
  if (conflicts.length > 0) return { conflicts, parentChanges };

  const candidate = CustomAgentSetupSchema.parse({
    ...structuredClone(fork),
    extends: {
      id: nextParent.metadata.id,
      version: nextParent.metadata.version,
    },
  });
  const resolved = resolveCustomSetup(candidate, nextParent, capabilities);
  return { conflicts: [], candidate, resolved, parentChanges };
}
