---
'@rosen-chains/abstract-chain': minor
---

Add an exported `EventReadView` type and a protected `verifyEventWithReader` helper so chains can verify concurrent events with a reader owned by each invocation. The public `verifyEvent` method continues to use the configured network.
