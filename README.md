# serverless-audit

A Claude Code plugin that finds the code that works on your laptop and breaks once it runs on Vercel or any other serverless host.

I run two products on Vercel, and most of my worst bugs never showed up locally: receipts that sent about half the time, a rate limit that let everything through, a webhook answered twice, a deploy that built fine on my machine and failed on the server. None of them were logic errors. They were all the same handful of serverless traps, so I wrote them down and made a scanner for them.

## What it catches

- **Work cut off after the response.** A promise that is not awaited can be killed the moment the function replies.
- **Memory that is not shared.** Rate limits, dedupe maps and caches held in memory live in one instance only.
- **Secrets in the browser.** Anything `NEXT_PUBLIC_` ships to every visitor.
- **Server variables read in client code,** which are silently undefined.
- **Timers and disk writes** that do not survive on a read-only, short-lived instance.
- **Cron jobs** that run more often than the Hobby plan allows.

The skill also covers what a scanner cannot see: case-sensitive imports that fail on Linux build servers, variables read at build time, body size and duration limits, and webhooks that do slow work before answering.

## Install

```
/plugin marketplace add degordonstech/serverless-audit
/plugin install serverless-audit@serverless-audit
```

## Using it

- `/serverless-audit:audit` scans the project, checks each finding by reading the code, and reports only the real problems, grouped by how much damage they do.
- `/serverless-audit:fix` works through them one at a time, showing each change before making it.

The skill also switches on by itself when you say something like "it works locally but not in production".

The scanner is one file with no dependencies. You can run it yourself:

```
node scripts/scan.mjs path/to/your/project
```

## Requirements

Node.js 18 or newer. Written for Next.js on Vercel, and most of it applies to any serverless Node host.

## License

MIT
