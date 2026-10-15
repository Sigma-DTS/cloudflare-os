# Durable agent continuations

## What main already does

The overseer stores an `activeAgents` row before running a turn. After a Durable Object
restart, its constructor reads those rows, re-resolves each original initiating user's model,
and starts the agent loop from the committed chat log. It does not restore a JavaScript stack.
Completed steps have their transcript and buffered workspace effects committed together; an
uncommitted step can lose partial output and repeat inference. A persisted final assistant
response is recognized and does not trigger another inference request.

That record covers active execution only. Approval/connection pauses clear it, and the client
decision handler starts another execution. A reset after persisting a decision but before
registering that execution can strand the wait. Main also treats a failed model lookup during
recovery as an unavailable model and ends the turn. Neither replay nor this continuation
mechanism guarantees exactly-once external effects when a receiver ran but its reply was lost.

## The continuation record

`agentContinuations`, keyed by chat ID, replaces the active-execution row. It retains the
initiating user, model and initiator, an execution ID, and a discriminated status:

```
starting -> running -> suspending -> paused -> starting
                \                     \
                 +------> finishing <---+ -> finished
```

Suspensions name their exact action/request IDs and persist a ready bit. The final decision
and wake-up are recorded synchronously, before profile/message-preparation I/O; recovery
finishes cleanup and resumes a ready wait without a browser. A resumed execution gets a new
ID. Cleanup checks that ID after awaits so an older execution cannot clear its successor.
An interrupted step that already committed decision cards recovers a manual wait before inference;
an auto-eligible pending action alone is not a pause. Resumption rechecks message preparation
after model lookup, and a newer prompt retires the old wait even when it selects no AI model.

One transition helper owns state changes; the overseer's driver handles model lookup,
execution and cleanup. Startup and alarms use the same runnable index. Unready pauses and
finished records do not drive alarms. A finished row is retained until the next execution so
late duplicate decisions cannot resurrect an old wait. Legacy active rows migrate once;
legacy pauses adopt the old client-authorized resume path into the same machine.

Integration lifecycle subscriptions, callback delivery/outboxes and recoverable contextual
actions are a separate layer, not part of this continuation core.
