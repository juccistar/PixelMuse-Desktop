import type * as Contract from "@ecomgen/contracts";
import type { Static } from "@sinclair/typebox";
export type PlanningJobInput = Static<typeof Contract.CreatePlanningJobInput>;
export function serializePlanningBody(input: PlanningJobInput): string {
    const types = input.requestedTypes ?? input.imageTypes;
    return JSON.stringify({
        planningMode: input.planningMode,
        requestedTypes: types,
        requestedSuiteShots: input.requestedSuiteShots,
        imageTypes: types,
        userInstruction: input.userInstruction,
        candidatesPerType: input.candidatesPerType,
        targetImageCount: input.targetImageCount,
        imageResolution: input.imageResolution,
        imageAspectRatio: input.imageAspectRatio,
        regenerationKey: input.regenerationKey,
    });
}
