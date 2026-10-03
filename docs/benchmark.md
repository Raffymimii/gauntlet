# Benchmark

This page is about the controlled benchmark. The numbers from real sessions (how often a
second family finds a serious issue in code Claude has just written, and what Claude does
next) come from [`bench/real-world.mjs`](../bench/real-world.mjs) and are summarised in the
[README](../README.md#on-real-work).

The question: hand the same code to one model, or to Gauntlet's council, and what comes
back? How many real bugs, how many false alarms, and how many findings pointing at code
that doesn't exist?

## The main set

[`bench/corpus`](../bench/corpus) has 16 samples in JavaScript, TypeScript and Python.
Twelve contain one bug that I planted, and three of those span two files. The other four
are correct. No file has a comment or a name that gives the bug away.

| Sample | The bug |
|---|---|
| `lru.js` | `get()` never refreshes recency, so the "LRU" cache is really FIFO |
| `semaphore.js` | A cache hit returns after `acquire()` without `release()`; the pool drains and everything hangs |
| `billing/charge.js` + `gateway.js` | Cents are passed where the gateway expects euros, so every charge is 100 times too big |
| `token-bucket.js` | Elapsed milliseconds times a per-second rate: the limiter never limits |
| `emitter.js` | `off()` with an unknown listener: `splice(-1, 1)` removes the last real one |
| `playlist.py` | A mutable default argument: every new playlist shares one list |
| `report.py` | A generator exhausted by the count, so revenue is always 0 |
| `http/client.js` + `config.js` | A timeout in seconds handed to `setTimeout`: every request is aborted after 30 ms |
| `admin/app.js` + `auth.js` | `DELETE /admin/users/:id` has no auth and is registered before the auth middleware |
| `booking.js` | Check-then-insert with no transaction: concurrent bookings overbook |
| `signup.js` | A nested quantifier in the email regex (ReDoS) |
| `versions.js` | `sort()` on version strings: 1.9.0 beats 1.10.0 |
| `split_bill.py`, `keyset.py`, `backoff.js`, `slug.js` | No bug |

I reproduced every bug with a short script before the run. The ReDoS, for example, goes
from 6 ms to 204 ms when the input grows by eight characters, and the semaphore hangs on
the sixth call. The four clean files were tested too, and checked by Codex, Gemini and
GPT-OSS until none of them found anything. Two of those checks turned up real edge cases
(a SQLite connection without named rows, and totals in scientific notation), and I fixed
them. Without those fixes the clean files wouldn't have been clean.

The expected answers are in [`bench/manifest.json`](../bench/manifest.json).

## How it runs

[`bench/run.mjs`](../bench/run.mjs) sends each sample to each reviewer through
Gauntlet's own pipeline:
- the same packet for everyone: the `codex_review` prompt, standard tier, the sample's
  files;
- fallback to another family is off;
- every sample starts with no paused models, and a provider error gets one retry.

If a reviewer still fails, that's a miss. Its work is never credited to whichever model
stepped in.

The reviewers:
- **Claude Sonnet 5.5** (through Antigravity): Claude reviewing on its own;
- **Codex GPT-5.6 Terra**;
- **Gemini 3.8 Flash**;
- **GPT-OSS 120B**.

From those answers [`bench/score.mjs`](../bench/score.mjs) also scores combinations:
- **Gauntlet council:** Codex, Gemini and GPT-OSS, counting a bug if any family found it,
  or only if two or more did;
- **Claude + Gauntlet council:** all four families, counting what two or more agree on.
  This is how it's used in practice: Claude writes the code and reads the council's
  reviews.

## How it's scored

The scoring is mechanical:

- **Found:** a finding counts when it is in the right file, within two lines of the bug,
  and its text names the problem (one of the manifest's keywords for that bug). The line
  used is where the quoted code really is in the file, when the quote is found there.
- **False alarm:** a high- or medium-severity finding on one of the four clean files. In
  the "agree" rows, an alarm counts only when two families flag the same spot (within
  three lines).
- **Made-up finding:** a finding whose quoted code isn't in the file, according to
  `src/verify.mjs`, the same check Gauntlet runs on every review.

## Results (3 runs, October 2026)

| Reviewer | Bugs found (of 12) | False alarms / run | Made-up findings | No answer | Median time |
|---|---|---|---|---|---|
| Claude Sonnet 5.5 | 12 (12, 12, 12) | 2.0 | 4 of 162 | 0 | 11.7 s |
| Codex GPT-5.6 Terra | 11 (11, 11, 11) | 0.3 | 3 of 40 | 0 | 10.4 s |
| Gemini 3.8 Flash | 11.7 (12, 12, 11) | 0.7 | 0 of 51 | 0 | 72.6 s |
| GPT-OSS 120B | 8.7 (9, 8, 9) | 2.0 | 3 of 69 | 6 | 85.9 s |
| Gauntlet council, any family | 12 (12, 12, 12) | 3.0 | 6 of 160 | 6 | 107.3 s |
| Gauntlet council, 2+ families agree | 10.7 (11, 11, 10) | 0.3 | 6 of 160 | 6 | 107.3 s |
| Claude + Gauntlet council, 2+ of 4 agree | 12 (12, 12, 12) | 0.7 | 10 of 322 | 6 | 107.3 s |

Bugs that single reviewers missed in every run:
- Codex: the ReDoS;
- GPT-OSS: the ReDoS and the mutable default.

Gemini missed the mutable default once.

The council's time is its slowest voice, since the families run in parallel. GPT-OSS is
slow and occasionally fails. If you don't need it, turn it off in the config and the
council takes about as long as Gemini.

## The easy set

The first version of this benchmark, in [`bench/easy`](../bench/easy), used textbook
bugs in small files:
- off-by-one;
- a missing `await`;
- SQL injection;
- path traversal;
- and the like.

Claude Sonnet 4.6, Codex and Gemini found 12 of 12 in both runs, and GPT-OSS 9.5. A
benchmark where everyone scores full marks can't tell reviewers apart, which is why the
main set exists. I'm keeping the easy set because it's an honest result too: on obvious
bugs you don't need a second opinion.

## Limits

- Sixteen samples is small, and I wrote the bugs. More varied corpora are welcome as
  pull requests.
- These are mostly single-file bugs. Changes that span a codebase are where reviewers
  should differ most, and this doesn't measure that yet.
- The bugs weren't written by the reviewer. Real self-review, where Claude checks code
  Claude just wrote, is the case Gauntlet was built for, and it's harder to benchmark
  fairly.
- Models change week to week. These numbers are for the dates on the raw files.

## Running it yourself

```bash
node bench/run.mjs --runs 1          # one run, about 30-60 minutes with all four reviewers
node bench/score.mjs                 # scores every raw file in bench/results together
node bench/charts.mjs                # redraws docs/bench/*.svg
node bench/run.mjs --set easy        # the easy set
```

The raw answers of the published runs are in [`bench/results`](../bench/results) and
[`bench/easy/results`](../bench/easy/results). Every number here can be recomputed from
them.
