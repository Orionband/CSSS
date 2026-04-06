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

## Running the Server
1.  `npm install`
2.  `node quickstart.js` (setup)
3.  `npm start`
4.  Access at `http://localhost:3000`

---

## 1. Packet Tracer Labs (`lab.conf`)
It's toml cuz aeacus


Defined in `[[labs]]` blocks.

### Lab Settings
You can customize resource usage and attempt limits per lab:
```toml
[[labs]]
id = "lab1_basic"
title = "Basic Lab"
show_score = true
show_check_messages = true
show_missed_points = true
comp_start = "2026-04-02T10:00:00Z"
comp_end = "2026-04-03T12:00:00Z"
max_submissions = 3
max_upload_mb = 10
max_xml_output_mb = 150
rate_limit_count = 5
rate_limit_window_seconds = 60
```

- ``show_score`` configures showing the score after competion
- ``show_check_messages`` configures showing the check messages after competion
- ``show_missed_points`` configures showing the missed points after competion
- ``comp_start`` and ``comp_end`` configure the competition window. 
- ``max_submissions`` configures the maximum times you can submit
- ``max_upload_mb`` controls the maximum size of an uploaded packet tracer
- ``max_cml_output_mb`` controls the maximum size of a decompressed packet tracer
- ``rate_limit_count`` controls ratelimiting of the submissions of packet tracers per the value of ``rate_limit_window_seconds``

### Lab Check Types

You can append **`Not`** to any check type to invert the logic (Pass if the condition is **FALSE**).

#### 1. ConfigMatch / ConfigMatchNot
Checks if a specific line exists (or does not exist) exactly as written.

**Example: Simple hostname check**
```toml
[[labs.checks]]
message = "Hostname Configured"
points = 5
device = "CPD"
    [[labs.checks.pass]]
    type = "ConfigMatch"
    source = "running"
    context = "global"
    value = "hostname CPD"
```

#### 2. ConfigRegex / ConfigRegexNot
Checks if a line matches (or does not match) a Regex pattern.

#### 3. XmlMatch / XmlMatchNot
Checks specific hardware/XML properties.

**Example: Check Switch Model**
```toml
[[labs.checks]]
message = "Correct Switch Model (2960-24TT)"
points = 5
device = "Branch-Switch"
    [[labs.checks.pass]]
    type = "XmlMatch"
    # Path: <TYPE> -> 1st Item -> Attributes ($) -> model
    path = ["TYPE", "0", "$", "model"]
    value = "2960-24TT"
```

#### 4. XmlRegex / XmlRegexNot
Use this to check if a value inside the XML matches a pattern (e.g., Serial Numbers, MAC Addresses).

#### 5. Type5Match / Type5MatchNot
Use this to securely check MD5 (Type 5) encrypted passwords in the configuration without hardcoding the salt/hash in the grader configuration. 

**Device Mode (enable secret):**
```toml
[[labs.checks]]
message = "Enable secret skibidi"
points = 10
device = "R1"
    [[labs.checks.pass]]
    type = "Type5Match"
    mode = "device"
    password = "skibidi"
    source = "running"
    context = "global"
```

**User Mode (username &lt;user&gt; secret):**
```toml
[[labs.checks]]
message = "Admin user has correct password"
points = 10
device = "R1"
    [[labs.checks.pass]]
    type = "Type5Match"
    mode = "user"
    username = "admin"
    password = "secretpassword"
    source = "startup"
    context = "global"
```

### Contexts
Where the grader looks for the config, examples:
- `global`: Top level (hostname, ip route).
- `interface [name]`: Inside an interface block.
- `router [proto]`: Inside a routing block.

Example:
interface GigabitEthernet0/0/0
 ip address 192.168.10.1 255.255.255.0
 duplex auto
 speed auto
 shutdown

```
    [[labs.checks]]
    message = "Check ip address 192.168.1.2 255.255.255..."
    points = 1
    device = "Router0"
        [[labs.checks.pass]]
        type = "ConfigMatch"
        source = "running"
        context = "interface GigabitEthernet0/0/0"
        value = "ip address 192.168.1.2 255.255.255.252"
```
### When distributing the packet tracer file, **ensure the answer network is deleted/replaced** inside the PKA activity wizard.

---

## 2. Quizzes (`quiz.conf`)

Defined in `[[quizzes]]` blocks.
```
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

- ``show_score`` configures showing the score after completion
- ``show_corrections`` configures showing the corrections after completion
- ``show_missed_points`` configures showing the missed points after completion
- ``comp_start`` and ``comp_end`` configure the competition window
- ``time_limit_minutes`` configures the time limit per attempt
- ``max_attempts`` configures the maximum number of attempts
- ``rate_limit_count`` controls ratelimiting of the submissions of packet tracers per the value of ``rate_limit_window_seconds``
### Quiz Question Types

*   **radio**: Single choice.
*   **checkbox**: Multiple correct answers.
*   **text**: Regex-validated text input.
*   **matching**: Drag and drop terms.

### Quiz Exhibits (Images & PKA Files)
You can attach an image or a downloadable `.pka` file to any question.

Assets must be placed inside the `protected/` directory at the root of your server, not in the public folder.
1. Images go in `protected/images/`
2. Packet Tracer exhibits go in `protected/pka/`

```toml
[[quizzes.questions]]
text = "Based on the provided Packet Tracer file and diagram, what is the IP address of Router A?"
type = "radio"
image = "topology.png"    # Placed in protected/images/topology.png
pka = "lab_scenario.pka"  # Placed in protected/pka/lab_scenario.pka
    [[quizzes.questions.answers]]
    text = "192.168.1.1"
    correct = true
```

## Server-Sided Security
- No answers on client for quizes
- No answers on client for packet tracer
- Time limit on server


## Free Servers & Configuration Builder
*   You can deploy CSSS to [Koyeb](https://www.koyeb.com/) or [Render](https://render.com/).
*   Use [cron-job.org](https://console.cron-job.org/login) to ping the server every 10 minutes to prevent sleeping.