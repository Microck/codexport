import { Clock, Effect, Layer, Option } from "effect";
import { AgentResolution } from "../agent/agent-resolution.service.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import {
  cleanupRollbackSnapshots,
  executeSynchronizationPlan,
  executionFollower,
  executionRevision,
} from "./executor.ts";
import { recoverSynchronizationPlan } from "./recovery.ts";
import { RollbackCleanupError } from "./synchronization.errors.ts";
import { Synchronization } from "./synchronization.service.ts";

const makeSynchronization = Effect.gen(function*() {
  const repository = yield* StateRepository;
  const machine = yield* MachineState;
  const agentResolution = Option.getOrUndefined(
    yield* Effect.serviceOption(AgentResolution),
  );

  return Synchronization.of({
    run: (input) =>
      Effect.gen(function*() {
        const follower = yield* executionFollower(input);
        const revision = yield* executionRevision(input);
        const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();

        // startRun atomically persists the full plan and all pending actions.
        // No MachineState operation is reachable before this succeeds.
        yield* repository.startRun({
          id: input.id,
          follower,
          revision,
          plan: input.plan,
          startedAt,
        });

        const result = yield* executeSynchronizationPlan({
          ...input,
          agentResolution: input.agentResolution ?? agentResolution,
        }).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
          Effect.catch((error) =>
            Effect.succeed({
              outcome: {
                outcome: "Failed",
                run: input.id,
                reason: String(error).slice(0, 2048),
              } as const,
              appliedResources: [],
              removedResources: [],
            })
          ),
        );
        const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* repository.completeRun({
          run: input.id,
          completedAt,
          outcome: result.outcome,
          appliedResources: result.appliedResources,
          removedResources: result.removedResources,
        });
        // A refused append-local rollback leaves evidence for manual recovery.
        const retainTextBackup = result.outcome.outcome === "Failed"
          && input.revision.resources.some((resource) => resource.policy === "append-local");
        if (result.outcome.outcome !== "Interrupted" && !retainTextBackup) {
          yield* cleanupRollbackSnapshots(input.id, input.plan.actions.map((action) => action.id)).pipe(
            Effect.provideService(MachineState, machine),
            Effect.mapError((error) => new RollbackCleanupError({
              run: input.id,
              outcome: result.outcome.outcome,
              message: String(error),
            })),
          );
        }
        return result.outcome;
      }).pipe(
        Effect.onInterrupt(() => Effect.void),
      ),
    recover: (input) =>
      Effect.gen(function*() {
        const recovery = yield* repository.loadRecovery(input.follower);
        const result = yield* recoverSynchronizationPlan({
          ...input,
          agentResolution: input.agentResolution ?? agentResolution,
        }).pipe(
          Effect.provideService(StateRepository, repository),
          Effect.provideService(MachineState, machine),
        );
        yield* repository.completeRun({
          run: result.outcome.run,
          completedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          outcome: result.outcome,
          appliedResources: result.appliedResources,
          removedResources: result.removedResources,
        });
        const retainTextBackup = result.outcome.outcome === "Failed"
          && input.revision.resources.some((resource) => resource.policy === "append-local");
        if (result.outcome.outcome !== "Interrupted" && !retainTextBackup) {
          yield* cleanupRollbackSnapshots(
            result.outcome.run,
            recovery?.run.plan.actions.map((action) => action.id) ?? [],
          ).pipe(
            Effect.provideService(MachineState, machine),
            Effect.mapError((error) => new RollbackCleanupError({
              run: result.outcome.run,
              outcome: result.outcome.outcome,
              message: String(error),
            })),
          );
        }
        return result.outcome;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function*() {
            const recovery = yield* repository.loadRecovery(input.follower);
            if (recovery === undefined) return;
            yield* repository.completeRun({
              run: recovery.run.id,
              completedAt: new Date(
                yield* Clock.currentTimeMillis,
              ).toISOString(),
              outcome: {
                outcome: "Interrupted",
                run: recovery.run.id,
                completedActions: recovery.actions
                  .filter((event) =>
                    event.state === "succeeded" || event.state === "skipped"
                  )
                  .map((event) => event.action),
              },
              appliedResources: [],
            });
          }).pipe(Effect.ignore)
        ),
      ),
  });
});

export const SynchronizationLive = Layer.effect(
  Synchronization,
  makeSynchronization,
);

export const synchronizationLayer = SynchronizationLive;
