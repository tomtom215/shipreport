# 07 · Scheduling

← [06 · Config reference](./06-config.md) · [Index](./README.md) · Next → [08 · Dry-run](./08-dry-run.md)

shipreport has no daemon. Scheduling is two things:

1. A coarse external trigger (GH Actions hourly cron, OS cron, K8s CronJob)
   calling `shipreport schedule tick`.
2. Per-team cron expressions inside `shipreport.yaml`. `tick` reads each
   team's `last_run_at` from SQLite, evaluates the cron, and runs only
   the teams whose schedule has come due since their last successful run.

Most external triggers are no-ops. That's by design: cheap to fire often,
no harm if you fire too often.

## Cron syntax

Five fields, separated by whitespace:

```text
minute  hour  day-of-month  month  day-of-week
0..59   0..23 1..31         1..12  0..6 (Sun..Sat)
```

Supported operators: `*`, integer, `a,b,c`, `a-b`, `*/n`, `a-b/n`.

Examples:

| Expression               | Meaning                                              |
| ------------------------ | ---------------------------------------------------- |
| `0 14 1 1,4,7,10 *`      | 14:00 on Jan 1, Apr 1, Jul 1, Oct 1.                 |
| `0 9 * * 1`              | 09:00 every Monday.                                  |
| `0 9 * * 1-5`            | 09:00 every weekday.                                 |
| `*/15 * * * *`           | Every 15 minutes (don't actually do this).           |
| `30 5 1 4,7,10,1 *`      | 05:30 on the 1st of Apr, Jul, Oct, Jan.              |

Times are evaluated in **UTC**. If you need "8am Eastern on Monday":

* If `defaults.timezone: America/New_York`, that's `0 13 * * 1` in winter
  (EST) and `0 12 * * 1` in summer (EDT). Pick the conservative one or
  use two crons.

Unsupported (will throw on parse):

* Named days (`MON`, `TUE`).
* Nicknames (`@yearly`, `@hourly`).
* Seconds field.
* `L` / `W` / `#` advanced specifiers.

If you need any of those, switch to OS cron + `shipreport run`.

## How `tick` decides what's due

```text
spec = parseCron(team.schedule)
last = SELECT last_run_at FROM schedule_state WHERE team = team.name
isDue = there exists a minute t in (last, now] such that cronMatches(spec, t)
```

Concretely:

* If you've never run, `last` is `NULL` and any past minute that matches
  the cron makes the team due.
* If you ran successfully on Mon at 09:00 and the cron is `0 9 * * 1`, the
  next due-time is Mon next week.
* If GH delays a scheduled trigger by 5 minutes — common during high
  load — the next `tick` still finds the matching minute and runs.

`tick` advances `last_run_at` past the trigger minute on success. On
failure, `last_run_at` is set to the failure time so a one-off transient
failure doesn't immediately re-fire on the next minute.

## Multi-team scheduling

Single workflow, many cadences:

```yaml
teams:
  - name: checkout
    schedule: "0 14 1 1,4,7,10 *"      # quarterly at 14:00
  - name: platform
    schedule: "0 9 * * 1"              # weekly Monday 09:00
  - name: research
    schedule: "0 9 1 * *"              # monthly on the 1st
```

Then run an hourly tick:

```yaml
on:
  schedule:
    - cron: "5 * * * *"
```

Each hour, `tick` evaluates each team's cron. Quarter-boundary hours run
all three; most hours run zero.

## On-demand runs and the schedule

`shipreport run --team <name>` (manual run, not via `tick`) **also**
updates `last_run_at` to "now". That suppresses the next scheduled run
until the cron matches a minute strictly after now. This is on purpose —
if you ran the team manually for a calibration meeting, the scheduled
run an hour later would just produce the same numbers.

Use `tick --force` to override that behaviour and run every team's
scheduled job regardless of last-run state. Not idempotent — only useful
for backfills.

## Idempotency

Calling `tick` twice in the same minute runs each team at most once,
because `last_run_at` is set on success and the cron-match scan is
left-open `(last, now]`.

A `tick` whose underlying `runTeam` fails records `last_status = "failed"`
and `last_quarter = NULL`, but still advances `last_run_at`. The next
hour's `tick` won't retry the same minute; if you want a retry, dispatch
manually or wait for the next scheduled minute.

## Timezone and quarter resolution

Scheduling cron is UTC; quarter boundaries are in `defaults.timezone`.
These are independent settings.

Example: `defaults.timezone: Pacific/Auckland`, `quarter: 2025Q4`:

* Quarter window: `2025-10-01 00:00:00 NZDT` → `2025-12-31 23:59:59 NZDT`.
  In UTC that's `2025-09-30 11:00:00Z` → `2025-12-31 10:59:59Z`.
* The team's cron `0 14 1 4 *` fires at 14:00 UTC on April 1, regardless
  of the timezone. If you want "14:00 Auckland time on April 1", that's
  `0 1 1 4 *` in UTC (Auckland is UTC+13 in April; UTC+12 the rest of
  the year). Pick whichever side of the DST boundary you prefer.

DST transitions are handled correctly by `Intl.DateTimeFormat` — see the
`tz.test.ts` golden cases.

## Dispatch from outside GitHub Actions

If you're scheduling from systemd, OS cron, or K8s CronJob, point the
trigger at `shipreport schedule tick --config /path/shipreport.yaml`.
That's the same idempotent path GH Actions uses.

`shipreport run --team X` (one team, on-demand) is also safe to call from
cron — it's a superset of `tick` for one team.

See [11 · Deploy: Local cron](./11-deployment-local-cron.md).

## Testing your schedule

Two paths:

* **`shipreport doctor`**: validates each team's cron expression and
  prints them. Catches bad syntax before the first scheduled run.
* **`shipreport schedule tick --force`**: actually runs every scheduled
  team. Useful as a one-time bootstrap or to backfill recent quarters.

## Common pitfalls

| Symptom                                                    | Root cause                                    | Fix                                                |
| ---------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| Scheduled team never runs                                  | Cron expression has 6 fields (seconds added). | Use 5 fields.                                      |
| Team runs every hour                                       | `* * * * *` or similar.                       | Tighten the cron (specify a minute + hour).        |
| Team ran manually then the schedule "skipped"              | Manual run advanced `last_run_at`.            | This is intended; use `tick --force` if you want it. |
| Two teams' schedules overlap and both ran in one hour       | Both cron expressions matched.                | Stagger them (e.g. `0 9` vs `5 9`).                |

Continue → [08 · Dry-run](./08-dry-run.md).
