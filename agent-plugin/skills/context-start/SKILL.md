---
name: context-start
description: Start an Agentic Context Manager context handle when beginning work that may span turns, sessions, or agents.
---

# Start ACM context

Use `acm.session.start` when beginning a substantial task. Bind the session to the narrowest stable workspace/repository and task identifiers available. Keep the returned `contextHandle` for later ACM calls.

Do not treat a context handle as authorization. The ACM server validates it against the authenticated principal.
