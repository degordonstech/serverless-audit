---
description: Scan this project for code that works locally but breaks on Vercel or other serverless hosting
---

Audit this project for serverless traps using the serverless-audit skill.

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.mjs .` from the project root and read its output.
2. Open every finding in its file and decide whether it is a real problem, using the "Judging a finding" notes in the skill. Drop the false alarms and say briefly why.
3. Walk the skill's checklist for what the scanner cannot see: case-sensitive imports, variables read at module load, runtime packages in devDependencies, body size and duration limits, webhook handlers that do slow work before answering.
4. Report the confirmed problems grouped by severity, each with file and line, what happens in production, and the smallest fix.

Do not change any code yet. End by asking which fixes I want applied.
