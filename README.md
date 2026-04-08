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

## Running the Server
1.  `npm install`
2.  `node quickstart.js` (setup environment)
3.  `npm start`
4.  Access at `http://localhost:3000`

---

## Directory Structure
- Assets for quizes and labs should be placed inside the ``protected/`` directory.
- ``captures/`` contains retained xml/pka/pkt files


## Tools

### `quickstart.js`
Run `node quickstart.js` to generate the `.env` file and configure settings.

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
- `comp_start` and `comp_end`: Configures the global competition window in UTC. If omitted/unset, the lab is always open.
- `time_limit_minutes`: Enforces a strict server-side deadline once the student clicks "Start Lab".
- `pka_file`: The filename of the starting file (must be in `protected/pka/`).
- `max_submissions`: The maximum times a student can submit.
- `rate_limit_count` / `rate_limit_window_seconds`: Rate limits requests

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
## Free Servers & Configuration Builder
*   You can deploy CSSS to [Koyeb](https://www.koyeb.com/) or [Render](https://render.com/).
*   Use [cron-job.org](https://console.cron-job.org/login) to ping the server every 10 minutes to prevent sleeping.
