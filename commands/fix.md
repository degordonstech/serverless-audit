---
description: Fix confirmed serverless traps one at a time, smallest change first
---

Fix the serverless problems from the last audit using the serverless-audit skill. If there is no audit in this conversation yet, run `/serverless-audit:audit` first.

Work through them one at a time, most severe first:

1. Show the problem and the exact change you propose, as a small diff.
2. Wait for me to approve it.
3. Make only that change. Keep the surrounding code as it is: same names, same style, no unrelated clean-ups.
4. Explain in one sentence how I can confirm it works once deployed.

If a fix needs something new, such as a database table for dedupe or a KV store for rate limits, say so before writing any code, because it changes the infrastructure and not just the file.
