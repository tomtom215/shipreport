# 11 · Deploy: Local cron / systemd / K8s CronJob

← [10 · Docker](./10-deployment-docker.md) · [Index](./README.md) · Next → [12 · Audit log](./12-audit-log.md)

If you can't or don't want to use GitHub Actions, schedule shipreport
from any cron-like trigger. The contract is identical: external trigger
fires often, `shipreport schedule tick` decides what to actually run.

## systemd timer (single host)

Pick this when you have one ops box and don't run K8s.

`/etc/systemd/system/shipreport.service`:

```ini
[Unit]
Description=shipreport tick
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=shipreport
Group=shipreport
EnvironmentFile=/etc/shipreport/env       # contains SHIPREPORT_GITHUB_TOKEN=…
ExecStart=/usr/local/bin/shipreport schedule tick --config /etc/shipreport/shipreport.yaml --verbose
TimeoutStartSec=30m
Nice=10

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/var/lib/shipreport /var/cache/shipreport
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
RestrictNamespaces=true
RestrictRealtime=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
```

`/etc/systemd/system/shipreport.timer`:

```ini
[Unit]
Description=hourly shipreport tick

[Timer]
OnCalendar=hourly
Persistent=true               # if the host was off when a tick should have fired, run on next boot
RandomizedDelaySec=5min       # spread load if many hosts run this

[Install]
WantedBy=timers.target
```

```bash
useradd --system --home-dir /var/lib/shipreport --shell /usr/sbin/nologin shipreport
mkdir -p /var/lib/shipreport /var/cache/shipreport /etc/shipreport
chown -R shipreport:shipreport /var/lib/shipreport /var/cache/shipreport

systemctl daemon-reload
systemctl enable --now shipreport.timer
```

`shipreport.yaml` should set:

```yaml
audit:
  path: /var/lib/shipreport/state.sqlite
cache:
  path: /var/cache/shipreport/cache.sqlite
```

…to match the `ReadWritePaths=` clause.

## OS cron

The five-minute version of the systemd setup. Less robust (no
`Persistent=true`, no journal logging), but fits anywhere.

```cron
5 * * * * /usr/local/bin/shipreport schedule tick --config /etc/shipreport/shipreport.yaml >>/var/log/shipreport.log 2>&1
```

Don't forget to set the env var that holds the token:

```cron
SHIPREPORT_GITHUB_TOKEN=ghp_…
5 * * * * /usr/local/bin/shipreport schedule tick --config /etc/shipreport/shipreport.yaml
```

…or source a file with `BASH_ENV=/etc/shipreport/env`.

Cron's mail-on-stderr behavior is the only "alerting" you get; redirect
logs somewhere ingestable.

## Kubernetes CronJob

Already covered in [10 · Docker](./10-deployment-docker.md#kubernetes-cronjob).

Two extras specific to long-term Kubernetes operation:

* **Resource requests** — set them. Memory at 256Mi, CPU at 100m is
  plenty for the typical run. PDF builds spike to ~1Gi memory; bump
  accordingly.
* **`activeDeadlineSeconds`** — set on the CronJob to e.g. 1800. A
  hung run is the most common reason an operator notices something's
  wrong; a deadline turns it into a hard failure visible in `kubectl
  get jobs`.

## Air-gapped scheduling without GHA

Combine [10 · Docker](./10-deployment-docker.md) (offline build) with the
K8s CronJob or systemd timer here. There's no upstream component
shipreport needs at runtime beyond GitHub itself.

The `audit export` step that GHA does via the `audit-export.yml`
workflow translates to a second cron entry:

```cron
30 5 * * * /usr/local/bin/shipreport audit export --config /etc/shipreport/shipreport.yaml --since "$(date -u -d '1 day ago' --iso-8601=seconds)" --format jsonl > /var/lib/shipreport/exports/$(date -u +%Y%m%dT%H%M%SZ).jsonl
```

Then sync `/var/lib/shipreport/exports/` to your WORM store.

## Common pitfalls

| Symptom                                                              | Root cause                                          | Fix                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| systemd: `audit.enabled: false — scheduler requires state DB...`     | shipreport.yaml has `audit.enabled: false`.          | `tick` requires the state DB. Re-enable audit.              |
| Cron job runs but "no team is due"                                    | `last_run_at` was advanced by an ad-hoc run.         | `tick --force` to override, or wait for the next match.     |
| State DB is empty after host reboot                                   | Cache backed by tmpfs.                               | Use a real disk-backed mount.                                |
| `Permission denied` writing to `~/.config/shipreport/audit-ed25519.pem` | systemd's `ProtectHome=true` blocks writes.         | Add `~/.config/shipreport` to `ReadWritePaths` or pre-bake. |

Continue → [12 · Audit log](./12-audit-log.md).
