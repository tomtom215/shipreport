# 16 · Delivering reports to non-technical managers

← [15 · FAQ](./15-faq.md) · [Index](./README.md)

shipreport **produces files**; it does not deliver them. After a run,
`out/` contains Markdown / HTML (and optionally PDF / PNG) artifacts.
Getting those into a manager's inbox, file share, or calendar is
operator-side glue — outside shipreport's scope on purpose, because
every org already has its own preferred channel.

This page collects the realistic patterns. None of them require the
manager to log into GitHub or open a terminal.

## Decide which artifact goes to whom

For each team, shipreport writes three categories of file:

| Filename pattern                              | Audience                      | Best format |
| --------------------------------------------- | ----------------------------- | ----------- |
| `<dev>-<quarter>.md` / `.html`                | The dev (1:1 self-review).    | HTML or PDF |
| `team-summary-<team>-<quarter>.{md,html}`     | The whole team (read-only).   | HTML        |
| `manager-rollup-<team>-<quarter>.{md,html}`   | The manager (calibration).    | PDF (one page, prints well) |

Most non-technical managers care about **the manager-rollup file** plus
optionally the per-dev pages for their direct reports. They almost
never want the team-summary unless you're using shipreport as a
status-update broadcaster.

PDF output requires `puppeteer` — see
[06 · Configuration reference](./06-config.md). On a host without
puppeteer, send the `.html` (renders inline in any modern email client
or browser).

## Pattern A — Email a PDF attachment (simplest)

The most common end state: the manager-rollup PDF lands in the
manager's inbox quarterly. Zero GitHub interaction. They open the
attachment.

The bundled
[`scripts/email-report.sh`](../scripts/email-report.sh) wraps this:

```bash
# After a successful run:
node bin/shipreport.js run --config shipreport.yaml --team checkout

# Then:
bash scripts/email-report.sh \
  --to "manager@your-corp.example" \
  --subject "Q1 2026 calibration pre-read — checkout team" \
  --file out/manager-rollup-checkout-2026Q1.pdf
```

The script dispatches via the first available transport:

1. `msmtp` (recommended — auth-friendly, runs on every Linux distro).
2. `sendmail` / `mail` / `mailx` (POSIX fallback).

Edit the script's top-of-file CONFIG section to point at your SMTP
relay. Air-gapped? Point it at your internal SMTP server — no public
Internet needed.

For sites that cannot run `msmtp` / `mail`, a small Python or curl
recipe accomplishes the same thing — both shown at the bottom of this
page.

## Pattern B — Shared drive / SharePoint / Box / Google Drive

If your organisation already has a shared filesystem the manager
checks (Windows network share, SharePoint document library, Google
Drive folder, Box folder, Dropbox Business folder), drop the rendered
files there.

```bash
# rsync over SSH to an internal share
rsync -avz --delete out/ ops@fileserver.internal:/srv/calibration/2026Q1/

# SMB / CIFS mount (Linux)
sudo mount -t cifs //fs01/calibration /mnt/calibration -o credentials=/etc/cifs.creds
cp out/manager-rollup-* /mnt/calibration/2026Q1/

# rclone for cloud destinations (Google Drive, OneDrive, S3, Azure Blob, …)
rclone copy out/ gdrive:calibration-readouts/2026Q1/
```

Air-gapped variant: any `rsync` / `scp` / SMB target on your internal
network works. `rclone` supports a long list of self-hosted targets
(Nextcloud, Seafile, S3-compatible MinIO).

## Pattern C — Email a rendered HTML inline

For managers who don't open attachments by policy: email the
manager-rollup HTML *as the body* rather than as an attachment. Most
mail clients render it inline.

```bash
mutt -e 'set content_type=text/html' \
     -s "Q1 2026 calibration pre-read — checkout team" \
     manager@your-corp.example \
     < out/manager-rollup-checkout-2026Q1.html
```

`scripts/email-report.sh --inline` does the same automatically (omits
the attachment, sends the HTML in the body).

## Pattern D — Print to PDF, hand over physically

For air-gapped facilities where the manager can't receive email at
all: `pnpm install puppeteer && node bin/shipreport.js run --pdf …`
produces a PDF. Print, slip into the calibration packet, walk it over.

## Pattern E — Internal static-site host

If your operations team already runs an internal HTTP server (nginx,
Caddy, an S3 bucket served behind SSO), the rendered `.html` files
work as a static site straight out of the box — no JS, no external
fonts, single embedded `<style>` block, CSP-clean (see
[14 · Security model](./14-security.md)).

```bash
rsync -avz --delete out/ /var/www/calibration/2026Q1/
# Manager browses to https://intranet.your-corp/calibration/2026Q1/manager-rollup-checkout-2026Q1.html
```

This is the lowest-friction option for managers who already use the
intranet daily — no email, no attachment, just a bookmarked URL.

## Pattern F — Slack / Teams / Mattermost message

For technical managers (skip if your manager isn't comfortable):
post the report as a Slack message with the HTML attached.

```bash
curl -F "file=@out/manager-rollup-checkout-2026Q1.html" \
     -F "channels=C0123456789" \
     -F "title=Q1 2026 calibration — checkout team" \
     -H "Authorization: Bearer xoxb-your-bot-token" \
     https://slack.com/api/files.upload
```

Microsoft Teams + Mattermost have similar webhook / file-upload APIs.
Air-gapped Mattermost / self-hosted Slack equivalents (Rocket.Chat,
Zulip) all work the same way.

## Pattern G — Calendar invite with PDF attachment

Useful when the manager-rollup is the agenda for a quarterly
calibration meeting: attach the PDF to the meeting invite.

* **Outlook / Exchange**: drag-and-drop the PDF into the calendar
  invite as an attachment.
* **Google Calendar**: use Google Workspace's "Add attachment" on the
  event creation form.
* **CalDAV / iCal scripts**: `vdirsyncer` + a small script can
  generate `.ics` files with attachments programmatically; out of
  scope for this guide.

## Wiring it into the schedule

Whichever pattern you pick, the integration point is **after** a
shipreport run finishes. Three common wirings:

### Local CLI

```bash
node bin/shipreport.js run --config shipreport.yaml --all && \
  bash scripts/email-report.sh --to manager@... \
       --file out/manager-rollup-*.pdf
```

### systemd

In `/etc/systemd/system/shipreport.service`, add an `ExecStartPost=`:

```ini
ExecStart=/usr/local/bin/shipreport schedule tick --config /etc/shipreport/shipreport.yaml
ExecStartPost=/usr/local/bin/email-report.sh \
              --to manager@your-corp.example \
              --pattern "/var/lib/shipreport/out/manager-rollup-*.pdf"
```

The `ExecStartPost` only runs when the main `ExecStart` exits 0, so a
failed run never sends a stale or empty report.

### GitHub Actions

Add a step after the `shipreport` job that uses your standard email-
sending action (e.g.
[`dawidd6/action-send-mail`](https://github.com/dawidd6/action-send-mail))
or pipes the artifact through Slack / Teams.

```yaml
- name: Email manager rollup
  if: success()
  uses: dawidd6/action-send-mail@<sha-pin>
  with:
    server_address: smtp.your-corp.example
    server_port: 587
    username: ${{ secrets.SMTP_USER }}
    password: ${{ secrets.SMTP_PASS }}
    subject: "Q1 2026 calibration pre-read"
    to: manager@your-corp.example
    from: shipreport-bot@your-corp.example
    attachments: out/manager-rollup-*.pdf
    body: file://out/manager-rollup-*.html
```

## Mapping teams → manager email

shipreport's `manager:` field in `shipreport.yaml` is the GitHub
login, not an email. For automated routing per-team, keep a simple
sidecar mapping you control:

```yaml
# managers.yaml — owned by you, not by shipreport.
checkout: manager-checkout@your-corp.example
platform: manager-platform@your-corp.example
research: manager-research@your-corp.example
```

`scripts/email-report.sh` reads `managers.yaml` if `--to` is omitted
and `MANAGERS_FILE` is set or the file is in the cwd, picking the
right address per team. Single-team deploys can skip this and pass
`--to` directly.

## What the manager sees

Whatever channel you pick, the manager-rollup is one short Markdown
table — N rows for N direct reports, columns for PRs merged, by kind,
reviews, services touched, issues closed, top PR link. It fits on a
single page when rendered to PDF in default settings. Manager opens
it, reads it, walks into the meeting prepared.

The per-dev success-story pages are the deeper artefact for the
manager's 1:1 prep (or for the dev's own self-review). Many
operators send only the rollup quarterly and make the per-dev pages
available on the shared drive on demand.

## Air-gapped considerations

Every pattern above works without public-Internet egress, with one
constraint: the SMTP relay / fileserver / internal Slack instance has
to be reachable from the host running shipreport.

| Pattern              | Air-gapped? | What you need internally           |
| -------------------- | ----------- | ---------------------------------- |
| A: Email             | Yes         | An internal SMTP relay.            |
| B: Shared drive      | Yes         | Any file-share protocol your org runs. |
| C: HTML inline email | Yes         | Same as A.                         |
| D: Print physically  | Yes         | A printer.                         |
| E: Static site       | Yes         | Any internal HTTP server.          |
| F: Slack/Teams       | Conditional | A self-hosted chat instance with an API. |
| G: Calendar          | Yes         | Your existing calendar server.     |

shipreport itself never touches any of these channels — it just
writes files. Whichever you pick, the credentials / endpoint config
lives in **your** tools (`~/.msmtprc`, `~/.ssh/config`,
systemd `EnvironmentFile=`, etc.), not in `shipreport.yaml`.

## Standalone Python / curl recipes

If `bash scripts/email-report.sh` doesn't fit your environment:

### Python `smtplib`

```python
#!/usr/bin/env python3
import smtplib, sys
from email.message import EmailMessage
from pathlib import Path

msg = EmailMessage()
msg["From"]    = "shipreport-bot@your-corp.example"
msg["To"]      = sys.argv[1]
msg["Subject"] = sys.argv[2]
msg.set_content("See attached calibration pre-read.")
data = Path(sys.argv[3]).read_bytes()
msg.add_attachment(data, maintype="application",
                   subtype="pdf", filename=Path(sys.argv[3]).name)
with smtplib.SMTP("smtp.your-corp.example", 587) as s:
    s.starttls()
    s.login("shipreport-bot", "<smtp-password>")
    s.send_message(msg)
```

### `curl` to AWS SES (or any HTTP-API SMTP gateway)

```bash
curl --request POST \
     --user "$SES_KEY:$SES_SECRET" \
     --form 'Action=SendRawEmail' \
     --form 'RawMessage.Data=...' \
     https://email.us-east-1.amazonaws.com/
```

(Most cloud email APIs have ready-made CLI wrappers — `aws ses
send-email`, `mailgun-cli`, etc.)

---

That's it. shipreport's job ends at `out/`; delivery is your choice
of channel and your existing tooling. Whatever your manager already
checks daily is the right channel.
