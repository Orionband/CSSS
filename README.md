# CSSS Documentation

## Why?
- The main purpose is to prevent cheating, whether that be through patching packet tracer or any other means. If there are any vulns you would like to report pls dm me at ``a_person9852`` on discord.
- Labs and quizes in the same place
- There is a leaderboard wow so cool competition
- You can customize feedback, like score or check messages.
- (Hopefully) better grading system with [CSSS Config Builder](https://github.com/Orionband/csss-config-builder), especially through "Show Differences Only"

## Notes
- You still need to provide a pka file and write instructions in activity wizard. (working on the latter)
- Because of the removal of the answer network/not grading in activity wizard, there can't be any dynamic feedback unless the user constantly uploads the packet tracer.
- It's toml cuz aeacus

## Fonts

The UI uses self-hosted **Roboto Mono** (weights 400 and 700) in [`public/fonts/`](public/fonts/). License: Apache 2.0. See [`public/fonts/LICENSE.txt`](public/fonts/LICENSE.txt). This was an attempt to make it faster.

## Running the Server
1.  `npm install`
2.  `node quickstart.js` (setup environment)
3.  `npm start`
4.  Access at `http://localhost:10000`

## Docker

CSSS can run in a hardened Alpine container. The SQLite database is persistent by default in the Docker named volume `csss-data`; it survives container restarts, rebuilds, and `docker compose down`. Do **not** run `docker compose down -v` unless you intentionally want to delete the database.

First, put your real `lab.conf`, `quiz.conf`, and PKA/image assets in:

- `configs/`
- `protected/pka/`
- `protected/images/`

### First Time Only

Create the session secret once. Do **not** run this again unless you intend to invalidate all sessions.

Linux, macOS, or Git Bash:

```bash
openssl rand -hex 32 > secrets/session_secret
```

Windows PowerShell:

```powershell
$bytes = New-Object byte[] 32
(New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
-join ($bytes | ForEach-Object { '{0:x2}' -f $_ }) | Set-Content -NoNewline secrets\session_secret
```

Then:

```bash
docker compose up -d --build
npm run docker:tool
```

### Start Again Later

```bash
docker compose up -d --build
```

The app is available at `http://localhost:10000`. Optional: create a `.env` file (see `.env.example`) to change settings such as `HOST_PORT`, `DISCORD_AUTH_ENABLED`, or feature flags. Docker Compose reads `.env` for those values; secrets still come from `secrets/`.

### Useful Commands

```bash
docker compose logs -f csss
docker compose stop
npm run docker:validate-config
npm run docker:tool
```

Docker defaults allow up to ~130s for in-flight grading jobs to finish on stop. Lower `SHUTDOWN_DRAIN_TIMEOUT_MS` and `STOP_GRACE_PERIOD` in `.env` for faster restarts when grading downtime is acceptable.

### Persistence

The database path inside the container is `/data/grader.db`. SQLite WAL files (`grader.db-wal` and `grader.db-shm`) live in the same `/data` volume, so WAL works correctly and stays persistent.

Backups/snapshots are optional copies, not what makes the DB persistent. For a manual backup, stop the container and archive the `csss-data` volume.

### Security Notes

- Secrets are read from `secrets/session_secret`, not `.env`.
- The container runs as the non-root `csss` user.
- The root filesystem is read-only; only `/data`, `logs/`, `captures/`, and `/tmp` are writable.
- `configs/` and `protected/` are mounted read-only.
- Use one CSSS container per database volume. Do not scale multiple replicas against SQLite.
- Keep the database volume on a local Docker volume or local disk. Avoid NFS/CIFS/network shares for SQLite.
- On Windows, use Docker Desktop with the named `csss-data` volume for the database; avoid bind-mounting the DB file.

For Discord OAuth secrets, see [`secrets/README`](secrets/README).

---

Before deploying or editing config, validate TOML files:

```bash
npm run validate-config
```

### Config validation

The server loads `lab.conf`, `quiz.conf`, and `homepage.conf` (when present) even when validation finds problems; it prints warnings to the console and continues starting. Use `npm run validate-config` for a strict check (exit code 1 on failure) in CI or before deploy.

Set `CSSS_SKIP_ASSET_VALIDATION=true` in `.env` to skip missing `pka_file` checks during local dev or tests.

| Area | Rules |
|------|--------|
| IDs | `^[a-zA-Z0-9_-]+$`, unique across labs and quizzes |
| Lab windows | `comp_start` / `comp_end` must be valid ISO datetimes; start must be before end |
| Upload caps | `max_upload_mb` between 1 and 50 (socket buffer limit); `max_xml_output_mb` must be positive |
| PKA assets | `pka_file` must exist under the project root unless asset checks are skipped |
| Lab checks | Each check needs `device`, `points`, and at least one `pass` or `passoverride` block; type must be a known check type; regex patterns must compile (RE2) |
| Quizzes | Question `type` must be `radio`, `checkbox`, `text`, or `matching`; radio questions need exactly one correct answer; checkbox needs at least one; text questions need `regex`; matching questions need non-empty `pairs` |
| Homepage | `logo` must be a safe path under `public/` (e.g. `/logo.png`); `comp_start` / `comp_end` must be valid ISO datetimes with start before end; titles ≤ 200 chars; block bodies ≤ 8000 chars |

This checks duplicate IDs, time windows, check shapes, regex compilation, homepage fields, and that `pka_file` / logo paths exist. If PKA files are not on disk yet (local dev), set `CSSS_SKIP_ASSET_VALIDATION=true` in `.env` or place assets under `protected/pka/` and reference them correctly in `lab.conf`.

---

## Testing

```bash
npm test              # unit + integration tests
npm run test:perf     # PKA decrypt performance (slow; optional)
npm run check           # eslint + tests
npm run validate-config # validate lab.conf / quiz.conf / homepage.conf
```

Tests run against **isolated temp SQLite databases** (not `grader.db`) with a **mock grader pool** — no worker threads are started. The harness sets `NODE_ENV=test` and `CSSS_SKIP_ASSET_VALIDATION=true` automatically.

Integration coverage includes CSRF enforcement, admin/owner boundaries, lab competition windows, quiz opaque answer IDs, socket grading-slot lifecycle, socket upload grading, session invalidation, and `/health`.

Each suite tears down HTTP/Socket.IO servers, closes temp and singleton database handles, and resets config overrides in `after()` hooks. Call `ctx.close()` in any custom test that uses `createTestApp()`.

`npm test` passes `--test-force-exit` because Socket.IO’s engine can leave an internal handle ref’d after teardown on some platforms; all application resources (DB, HTTP server, timers) are still closed explicitly in `ctx.close()`.

---

## Directory Structure
- Config files live in `configs/` (`lab.conf`, `quiz.conf`, optional `homepage.conf`).
- Assets for quizes and labs should be placed inside the ``protected/`` directory.
- ``captures/`` contains retained xml/pka/pkt files


## Tools

### `quickstart.js`
Run `node quickstart.js` to generate the `.env` file and configure settings. You can optionally create an **owner** account — the first privileged account with full admin panel access. Only the owner can create additional **admin** accounts; admins can manage users but cannot grant admin privileges.

For existing installs without an owner, designate one manually in the database:
`UPDATE users SET is_admin = 1, is_owner = 1 WHERE id = ?;`

### `tool.js`
Run `node tool.js` to admin stuff like
- View all users and submissions.
- Create new users manually
- Reset user passwords.
- Delete users safely.
- Wipe all submissions for a specific user 
- Delete a specific submission by its ID.

---

## 1. Packet Tracer Labs (`lab.conf`)

Defined in `[[labs]]` blocks.

### Lab Settings
```toml
[[labs]]
id = "lab1_basic"
title = "Basic Lab"
show_score = true
show_check_messages = true
show_missed_points = true
comp_start = "2026-04-02T10:00:00Z"
comp_end = "2026-04-03T12:00:00Z"
time_limit_minutes = 20
max_submissions = 3
max_upload_mb = 10
max_xml_output_mb = 150
rate_limit_count = 5
rate_limit_window_seconds = 60
pka_file = "lab1_starter.pka"
```

- `show_score`, `show_check_messages`, `show_missed_points`: Configures student feedback after submission.
- `comp_start` and `comp_end`: Configures the global competition window in UTC. Format: YYYY-MM-DDTHH:MM:SSZ. If omitted/unset, the lab is always open.
- `time_limit_minutes`: Enforces a strict server-side deadline once the student clicks "Start Lab".
- `pka_file`: The filename of the starting file (must be in `protected/pka/`).
- `max_submissions`: The maximum times a student can submit (final lab attempts only; live-stream poll grades do not count toward this limit).
- `rate_limit_count` / `rate_limit_window_seconds`: Rate limits requests

### Live Streaming (`live_streaming`)

Per-lab optional mode for grading a Packet Tracer file while the student is still working, instead of only at the end.

```toml
[[labs]]
id = "lab_streaming"
title = "Streaming Lab"
live_streaming = true
max_submissions = 0          # recommended: stream polls do not count, but 0 avoids confusion
time_limit_minutes = 60
show_score = true
show_check_messages = true
pka_file = "lab_starter.pka"
```

**Enable in `lab.conf`:** set `live_streaming = true` on a `[[labs]]` block.

**Student workflow**
1. Start the lab as usual.
2. Pick their `.pka` / `.pkt` file when prompted (uses the browser **File System Access API**).
3. Work in Packet Tracer and **save the file often**.
4. CSSS checks the file every **2 minutes**. If the saved file changed since the last successful grade, it is sent for grading automatically.
5. When finished, the student must click **Submit** for the final grade (this closes the lab session).

**Browser requirement:** live streaming requires a **Chromium-based browser** (Chrome, Edge, or Opera). Firefox and Safari do not support the File System Access API.

**Behavior**
- Stream grades use the same checks and feedback settings as a normal submission (`show_score`, `show_check_messages`, etc.).
- Intermediate stream grades are stored separately (`stream_poll` rows) and **do not** count toward `max_submissions`.
- Only the final **Submit** closes the session and counts as a lab attempt.
- If the student's score increases on a stream grade, the UI plays `gain.wav` and may show a notification.
- Server rate limit: at most one accepted stream grade per user/lab every **115 seconds** (slightly under the 2-minute client interval).
- If `RETAIN_PKA` / `RETAIN_XML` are enabled, captures are written only on the final Submit, not on stream polls.

**Tips for instructors**
- Tell students to save Packet Tracer frequently; grades only run when the saved file on disk changes.
- Use `max_submissions = 0` (unlimited attempts) on streaming labs unless you intentionally want to cap how many times a student can *start* a new session.
- Without live streaming, students select a file and click **Submit** once at the end (standard mode).

### Check Sources & Contexts
Every config check requires a `source` and a `context`:
- `source`: Must be either `"running"` (Running Config) or `"startup"` (Startup Config).
- `context`: Where the grader looks for the command.
  - `"global"`: Top level (e.g., `hostname`, `ip route`).
  - `"interface [name]"`
  - `"router [proto]"`

### More Grading Logic (`fail`, `passoverride`, `pass`)
Each check evaluates conditions in a strict hierarchy:
1. `fail`: If any condition in this block matches, the check immediately fails.

```toml
[[labs.checks]]
message = "VTY lines allow SSH only"
points = 2
device = "Router0"

    # If the user explicitly typed 'transport input telnet', immediately fail them
    [[labs.checks.fail]]
    type = "ConfigMatch"
    source = "running"
    context = "line vty 0 4"
    value = "transport input telnet"
    
    # If they didn't fail the above, check if they configured SSH
    [[labs.checks.pass]]
    type = "ConfigMatch"
    source = "running"
    context = "line vty 0 4"
    value = "transport input ssh"
```
2. `passoverride`: If any condition in this block matches, the check immediately passes (ignoring standard pass conditions).

```toml
[[labs.checks]]
message = "GigabitEthernet0/0 is in OSPF area 0"
points = 2
device = "Router0"

    # Standard pass: interface-level OSPF command
    [[labs.checks.pass]]
    type = "ConfigMatch"
    source = "running"
    context = "interface GigabitEthernet0/0"
    value = "ip ospf 1 area 0"
    
    # Alternate valid solution: classic network statement under router ospf
    [[labs.checks.passoverride]]
    type = "ConfigMatch"
    source = "running"
    context = "router ospf 1"
    value = "network 10.0.0.0 0.0.0.255 area 0"
```

3. **`pass`**: All conditions in this block must match for the check to pass.

### Penalties (Negative Points)
You can assign negative integers to `points` to act as penalties for misconfigurations.
- The `max_score` for the lab is calculated by adding up *only* positive points.
- If a student triggers a penalty check, points are deducted from their total.
- The total score is clamped to a minimum of `0` (students cannot get a negative total score).

### Lab Check Types
You can append `Not` to any check type to invert the logic (e.g., `ConfigMatchNot`).

1. **ConfigMatch**: Exact string match against a config line.
2. **ConfigRegex**: Regex pattern match against a config line.
3. **XmlMatch**: Exact match on a hardware/XML property. Array paths are defined sequentially: `path = ["MODULE", "SLOT", "0", "PORT", "IP"]`. Lowkey just use the builder for this.
4. **XmlRegex**: Regex match on an XML attribute.
5. **Type5Match**: Securely validates MD5 passwords without needing the salt. Mode must be `"device"` (for `enable secret`) or `"user"` (for `username secret`).

---

## 2. Quizzes (`quiz.conf`)

Defined in `[[quizzes]]` blocks. All quizzes present in this file are automatically enabled and active (subject to the competition window).

### Quiz Settings
```toml
[[quizzes]]
id = "quiz1"
title = "Quiz 1"
show_score = true
show_corrections = true
show_missed_points = true
comp_start = "2026-04-02T10:00:00Z"
comp_end = "2026-04-03T12:00:00Z"
time_limit_minutes = 15
max_attempts = 3
rate_limit_count = 5
rate_limit_window_seconds = 60
```

### Quiz Question Types
You can attach an image (`image = "file.png"`) or a PKA (`pka = "file.pka"`) to any question.

#### 1. Multiple Choice 
```toml
[[quizzes.questions]]
text = "What color is the sky?"
type = "radio"
points = 1
explanation = "The sky is blue!!!!"
    [[quizzes.questions.answers]]
    text = "Red"
    correct = false
    [[quizzes.questions.answers]]
    text = "Blue"
    correct = true
    [[quizzes.questions.answers]]
    text = "Green"
    correct = false
    [[quizzes.questions.answers]]
    text = "Purple"
    correct = false
```

#### 2. Checkbox 
```toml
[[quizzes.questions]]
text = "Select everyone that is a mod"
type = "checkbox"
points = 1
explanation = ""
    [[quizzes.questions.answers]]
    text = "x1nni"
    correct = true
    [[quizzes.questions.answers]]
    text = "avril"
    correct = true
    [[quizzes.questions.answers]]
    text = "byrch"
    correct = false
    [[quizzes.questions.answers]]
    text = "lolmeow"
    correct = true
```

#### 3. Text 
```toml
[[quizzes.questions]]
text = "Whose order is this? "
type = "text"
points = 1
image = "exhibit1.png"
explanation = "He is a big back!"
regex = "^!?lolme(?:ow|now)$"
```

#### 4. Matching
```toml
[[quizzes.questions]]
text = "Match each person to the correct role"
type = "matching"
points = 1
explanation = ""
    [[quizzes.questions.pairs]]
    left = "Anywheres"
    right = "Windows"
    [[quizzes.questions.pairs]]
    left = "eth007"
    right = "Linux"
    [[quizzes.questions.pairs]]
    left = "noobfooditem"
    right = "Cisco"
```

---

## 3. Landing Page (`homepage.conf`)

Optional TOML file at `configs/homepage.conf`. When `enabled = true`, CSSS serves a public landing page at `/` instead of the login form. Login moves to `/login`; the nav brand link points to `/` instead of `/challenges`.

If the file is missing, or `enabled` is `false`, behavior is unchanged: `/` shows login and `/login` redirects to `/`.

### How to create it

1. Create the configs directory if it does not exist: `configs/` (this folder is gitignored; each deployment keeps its own copy).
2. Add a logo image under `public/` (default path is `public/logo.png`).
3. Create `configs/homepage.conf` with `enabled = true` and the fields below.
4. Validate: `npm run validate-config` (should print `homepage enabled` when active).
5. Restart the server (or rely on config reload if you use that workflow).

Minimal example:

```toml
[homepage]
enabled = true
page_title = "Spring Networking Event"
```

Full example:

```toml
[homepage]
enabled = true
page_title = "Spring Networking Event"
subtitle = "Packet Tracer labs and quizzes — good luck!"
logo = "/logo.png"
comp_start = "2026-04-02T10:00:00Z"
comp_end = "2026-04-03T12:00:00Z"
period_label = "April 2–3, 2026 (UTC)"

[homepage.readme]
title = "About"
body = """
Welcome to the event landing page.
Use the Login link to sign in and open Challenges when you are ready.
"""

[homepage.rules]
title = "Rules"
body = "No sharing answers. One account per person."

[homepage.prizes]
title = "Prizes"
body = "Top three on the leaderboard win swag."
```

### Settings

| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | Yes (to activate) | Must be `true` for the landing page. Any other value, or a missing file, keeps login at `/`. |
| `page_title` | No | Main heading on the page and part of the browser tab title. |
| `subtitle` | No | Subheading under the title. |
| `logo` | No | URL path to an image in `public/` (default: `/logo.png`). Must start with `/` and must not contain `..`. |
| `comp_start` | No | Competition window start (UTC ISO 8601, e.g. `2026-04-02T10:00:00Z`). |
| `comp_end` | No | Competition window end (same format). If both are set, `comp_start` must be before `comp_end`. |
| `period_label` | No | Custom text for the date row. When set, it is shown instead of the raw `comp_start` / `comp_end` values. |

### Text blocks (`readme`, `rules`, `prizes`)

Each block is an optional `[homepage.<name>]` table:

- `title` — section heading (defaults: `README`, `Rules`, `Prizes`).
- `body` — plain text shown in a `<pre>` block (whitespace preserved). Use TOML multiline strings (`""" ... """`) for paragraphs.

A section is hidden when `body` is empty or omitted. Block titles are limited to 200 characters; bodies to 8000 characters.

### Competition status badge

When `comp_start` and/or `comp_end` are valid, the landing page shows a badge:

- **Upcoming** — before `comp_start`
- **Live** — inside the window
- **Ended** — after `comp_end`

Invalid dates do not fail the server; the badge is simply omitted.

### Behavior when enabled

| Route / UI | Homepage off | Homepage on |
|------------|--------------|-------------|
| `/` | Login form | Landing page (`home.html`) |
| `/login` | Redirects to `/` | Login form |
| Nav brand link | `/challenges` | `/` |
| `/api/config` | No `homepage` field | Includes `homepage` payload and `options.homepage_enabled: true` |

The landing page is public (no login required). Challenge list and grading still require authentication.

### Disabling

Delete `configs/homepage.conf`, or set `enabled = false`, then restart. `/` returns to the login page.

---

## Free Servers & Configuration Builder
*   You can deploy CSSS to [Koyeb](https://www.koyeb.com/) or use something like ngrok
*   Use [cron-job.org](https://console.cron-job.org/login) to ping the server every 10 minutes to prevent sleeping.