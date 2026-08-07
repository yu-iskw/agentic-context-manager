---
name: context-checkpoint
description: Prepare for a durable task checkpoint or handoff at meaningful boundaries.
---

# Checkpoint task context

The initial ACM vertical slice does not yet expose validated compaction as a model-controlled tool. Until that lands, record the key decision, requirement, test result, or unresolved question with `acm.event.record` at meaningful task boundaries instead of dumping every transient token into long-term memory.

Prefer explicit `decision`, `test_result`, and `handoff` event kinds when they accurately describe the event.
