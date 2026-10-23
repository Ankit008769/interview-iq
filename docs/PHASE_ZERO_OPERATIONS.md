# Phase 0 operations

## History

`GET /api/interviews?limit=20&cursor=...` returns `interviews` and `nextCursor`.
Limits must be integers from 1 to 50. A null cursor means the last page. Pagination
uses descending creation time and ObjectId, including ties. The owner filter is
always applied independently of cursor content. Newer sessions created between
page loads appear after refreshing history, rather than shifting older pages.
The client retains loaded rows and the cursor when a subsequent request fails.

## Account bootstrap

Only an HTTP 401 from `/api/auth/me` means signed out. Network, service and response
errors display a retry state without redirecting away from the requested route.
Fetch requests time out after 30 seconds; obsolete bootstrap requests are aborted.
Failed sign-out leaves the local session visible until the server confirms logout.

## Shared limits

| Environment variable | Default | What is counted |
|---|---|---|
| INTERVIEW_WRITES_PER_15_MIN | 40 | Authenticated create/answer/retry requests, including invalid/replayed requests |
| INTERVIEWS_PER_DAY | 20 | Valid interview-start attempts, including downstream generation failures |
| AI_CALLS_PER_DAY | 100 | Initial AI questions and each worker AI attempt, including provider errors |

MongoDB counters are per account and fixed time window, shared across processes.
Daily windows reset at 00:00 UTC (05:30 India Standard Time). The 15-minute windows
are aligned to UTC quarter hours. Conditional increments prevent concurrent
requests from exceeding limits. TTL cleanup removes old counters but is not used
to decide whether a quota has reset. Failed downstream work is not refunded; this
prevents repeated failures from bypassing cost limits. The provider SDK performs
no hidden retries; durable worker attempts consume their own quota.

Quota errors return 429 with JSON `code: QUOTA_EXCEEDED`, `resetAt`, and Retry-After
seconds. Reads/polling do not consume write quotas. Already accepted AI work waits
until the daily reset without losing answers or exhausting its retry budget.
Practice mode does not consume AI quota. All quotas require database availability;
there is no in-memory fail-open fallback. Limits must be positive integers.

These are operational request/call limits, not currency budgets. A paid provider
must also have token/output limits and account spending controls configured.
Authentication retains its separate per-process IP limiter; multi-instance public
launch should move that limiter to shared storage or an edge service as well.

## Deployment configuration

Production requires an exact HTTPS CLIENT_ORIGIN, a non-placeholder JWT secret,
MONGODB_URI and a valid PORT. Set SERVE_CLIENT=true to serve the built React client
and API together. Only configure TRUST_PROXY_HOPS for the known reverse-proxy path;
it defaults to zero. Health returns 503 if MongoDB is disconnected.

The Docker build excludes local environments, private keys, dependencies, test
artifacts and Git internals. Google Cloud source uploads use matching exclusions.
No AI key is required for a practice-mode staging deployment.

Local verification: both builds, 25 MongoDB-backed tests and 9 Chromium tests.
Live AI scoring quality, load testing and broader browser coverage remain separate
release checks. See ANSWER_RECOVERY.md for worker guarantees and limitations.
