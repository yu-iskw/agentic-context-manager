---
name: context-checkpoint
description: Create a validated durable checkpoint at meaningful task or handoff boundaries.
---

# Checkpoint task context

Use `acm.context.checkpoint` after the current session's asynchronous ingestions have completed and before a meaningful handoff, interruption, or context reset.

The current checkpoint strategy is deliberately conservative: it preserves required lifecycle memories such as decisions, requirements, and unresolved questions verbatim within the requested token budget. If those required memories cannot all fit, checkpoint creation is rejected instead of silently discarding them.

Continue to use `acm.event.record` for durable decisions, requirements, test results, handoffs, and other high-value events before creating the checkpoint.
