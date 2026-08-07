---
name: context-debug
description: Diagnose unexpected ACM recall behavior using context-pack explanations and provenance.
---

# Debug recalled context

Request `includeExplanations: true` from `acm.context.recall`. Check scope, semantic, lexical, and provenance information before assuming the stored memory is wrong.

If a relevant item is absent, verify first that it was durably recorded and that ingestion completed. Do not work around a scope denial by broadening or fabricating identity fields.
