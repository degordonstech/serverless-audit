---
name: serverless-audit
description: Find and fix the bugs that only appear once a Next.js or Node app runs on serverless hosting such as Vercel, Netlify or AWS Lambda. Covers work cut off after the response, in-memory state that is not shared between instances, timers, disk writes, environment variables that are undefined in the browser or leaked into it, cron limits, case-sensitive imports, body size and duration limits. Use whenever someone says it works on localhost but not on Vercel or in production, a webhook, email or receipt only sometimes happens, a webhook is handled twice, a rate limit or cache does not seem to work, an environment variable is undefined in production or a NEXT_PUBLIC_ key may be exposing a secret, a cron job never runs or the Hobby plan rejects it, writing a file fails with EROFS (read-only file system), a function times out, a deploy fails with "Module not found" on the host but builds on their machine, or they want a production readiness check before launch.
---

# Works on my laptop, breaks on serverless

On your laptop one Node process runs forever and keeps everything in memory. On serverless hosting each request may land on a different short-lived instance, the process can freeze the moment the response is sent, and the disk is read-only. Code that is correct locally quietly misbehaves, and the failures look random, which is why they are so expensive to debug.

Every rule below comes from a real production bug. Work through them in this order, because the first ones lose data and the last ones only fail loudly.

## How to run an audit

1. Run the scanner: `node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.mjs <project-folder>`. It needs Node 18 or newer and nothing else.
2. Read every finding in its file before judging it. The scanner finds the shape of the bug; you decide whether it is one (see "Judging a finding" under each rule).
3. Walk the checklist below for the traps a scanner cannot see.
4. Report findings grouped by severity, each with the file and line, what goes wrong in production, and the smallest fix. Do not change code until the person agrees.

## 1. Work cut off after the response (loses data)

A serverless function can stop as soon as it returns a response. Any promise still running at that moment may be frozen or killed. It works most of the time, which is exactly why it takes days to notice.

```js
// Broken: the email may never send
sendReceipt(order)
return Response.json({ ok: true })

// Fixed: finish it first
await sendReceipt(order)
return Response.json({ ok: true })

// Fixed, when the caller must not wait (webhooks that must answer fast)
import { after } from 'next/server'        // Next.js 15.1+
after(() => sendReceipt(order))
return Response.json({ ok: true })
```

Outside Next.js, use `waitUntil` from `@vercel/functions`, or the platform's own equivalent.

Judging a finding: a `.then()` or `.catch()` chain started as its own statement, or a bare `fetch(...)`, is almost always the bug. Anything already inside `await`, `return`, `after()` or `waitUntil()` is fine.

## 2. In-memory state is per instance (wrong answers)

A `Map`, `Set` or `let` at the top of a file lives only in that instance. Other instances have their own empty copy, and any instance can be recycled at any time. With concurrent instances, the same user can hit two of them in the same second.

- **Rate limits** held in memory let through far more than the limit.
- **Dedupe maps** ("have I seen this webhook?") miss retries that land on another instance, so things happen twice.
- **Caches** are fine as long as a cache miss is only slower, never wrong.

Fix: move anything correctness depends on into shared storage. A database row with a unique constraint is the simplest dedupe (insert the message id, and a duplicate insert fails). Use Redis or a KV store for rate limits.

Judging a finding: an in-memory map in front of a database claim is a harmless speed-up. An in-memory map that is the only guard is the bug. Say which one it is.

Also know: some hosts now run several requests in the same instance at once (Vercel calls this fluid compute). Module-level state can then leak between two different users' requests. Never keep per-user data at module scope.

## 3. Secrets and environment variables

- Anything named `NEXT_PUBLIC_...` is copied into the browser bundle. A secret with that prefix is published to every visitor. Rename it and read it only on the server.
- A server-only variable read in a `'use client'` file is `undefined` in the browser. The feature silently does nothing.
- **Changing a variable does not change a running deployment.** Environment variables are fixed at build or deploy time. After changing one in the dashboard, redeploy.
- `NEXT_PUBLIC_` values are baked in at build time. Changing them needs a new build, not just a restart.

## 4. Timers and background loops

`setTimeout` and `setInterval` in request code do not survive the function finishing. A retry "in five minutes" never happens. Do the work now, use `after()`, or schedule it with a cron job or a queue.

An awaited sleep (`await new Promise(r => setTimeout(r, 200))`) and an abort timer for a fetch are fine.

## 5. The disk is read-only

Only `/tmp` is writable, it is small, and it belongs to one instance that can disappear. Uploads, generated files and anything that must survive go to object storage (S3, Vercel Blob, Supabase Storage, R2).

## 6. Scheduled jobs

On Vercel (limits checked in 2026):

| | Cron jobs per project | Most often | Timing |
|---|---|---|---|
| Hobby | 100 | once a day | anywhere within the hour |
| Pro | 100 | once a minute | to the minute |

A Hobby project with an hourly or every-five-minutes cron fails at deploy. Schedules are in UTC. Every cron route must check a secret (Vercel sends `Authorization: Bearer $CRON_SECRET`) or anyone can trigger it. A free outside scheduler such as cron-job.org can call the same route more often if the route accepts the key as a header or query string.

## 7. It builds locally but fails on the host

- **Case-sensitive imports.** Windows and macOS ignore case, Linux build servers do not. `import Button from './button'` works locally and fails on the host when the file is `Button.js`.
- **Missing environment variables at build time.** Code that reads a variable at module load (creating a database client at the top of a file) crashes the build when the variable is absent. Read variables inside the handler, or give the client a safe placeholder.
- **Dependencies only on your machine.** A package installed globally, or only in `devDependencies` but needed at runtime, is missing on the host.
- **Check the deployment, not your terminal.** A green local build proves nothing about the hosted one. Open the deployment's build log.

## 8. Hard limits worth knowing (Vercel, 2026)

- **Request and response body:** 4.5 MB. Upload large files straight from the browser to storage with a signed URL instead of through a function.
- **Duration:** 300 seconds on Hobby, up to 800 on Pro. Long jobs belong in a queue or a workflow, not one request.
- **Webhooks:** most senders (Meta, Stripe, Paystack) retry if you do not answer quickly. Verify the signature, record the event, answer 200, and do the slow work in `after()`.

Limits change. When a number matters to the decision, check the host's current documentation before quoting it.

## Reporting

Group the report as:

1. **Loses data or money:** unawaited work, dedupe or rate limits that are the only guard, secrets in the browser.
2. **Wrong but recoverable:** caches, timers, client env reads.
3. **Fails loudly:** cron frequency, case-sensitive imports, build-time variables.

For each: file and line, one sentence on what happens in production, and the smallest fix. Offer to apply fixes one at a time.
