# CSSS Documentation

## Why?
*   **Anti-Cheat**: Keeps answers on the server, not in the file.
*   **Unified**: Labs and Quizzes in one place.
*   **Competition**: Live leaderboards.

## Running the Server
1.  `npm install`
2.  `npm start`
3.  Access at `http://localhost:3000`

---

## 1. Packet Tracer Labs (`lab.conf`)

Defined in `[[labs]]` blocks.

### Lab Check Types (The 4 Core Logic Types)

#### 1. ConfigMatch (Exact String)
Use this for static commands that never change.
```toml
[[labs.checks]]
message = "Hostname Configured"
points = 5
device = "R1"
    [[labs.checks.pass]]
    type = "ConfigMatch"
    source = "running"
    context = "global"
    value = "hostname R1"
```

#### 2. ConfigRegex (Pattern Match)
Use this for variable data like **Encrypted Passwords**, **Usernames**, or **Descriptions** where dates/times might change.

**Example: Encrypted Enable Secret**
*   Packet Tracer generates a random salt (e.g., `$1$mERr$`). You cannot match this with a simple string. You must use Regex.
*   **Note**: Double escape backslashes in TOML (`\\`).

```toml
[[labs.checks]]
message = "Enable Secret Password Configured"
points = 10
device = "R1"
    [[labs.checks.pass]]
    type = "ConfigRegex"
    source = "running"
    context = "global"
    # Logic: Matches "enable secret 5" followed by any MD5 hash string
    value = "^enable secret 5 \\$1\\$.*"
```

#### 3. XmlMatch (XML Structure Exact)
Use this to check specific values anywhere within the `.pka` XML structure (e.g., Device Model, X/Y Coordinates, Simulation Time, or Internal States).

**Example A: Checking Text Content**
Checks the value *between* tags: `<TYPE>Router</TYPE>`
```toml
[[labs.checks]]
message = "Correct Device Type"
points = 5
device = "HQ-Router"
    [[labs.checks.pass]]
    type = "XmlMatch"
    path = ["TYPE"]
    value = "Router"
```

**Example B: Checking Attributes (Critical)**
Checks values *inside* the tag definition: `<TYPE model="2960-24TT">`
*   You must use `"$"` to access attributes.
*   `"0"` is required to select the first item in the list of tags.

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

#### 4. XmlRegex (XML Structure Pattern)
Use this when an XML value might be stored in different formats (e.g., Hex vs. Decimal) or to check for a specific state regardless of surrounding text.

**Example: Password Recovery (Config Register)**
*   **Scenario**: A student must set the config register to `0x2142`.
*   **Problem**: Packet Tracer sometimes saves this as Hex (`0x2142`) and sometimes as Decimal (`8514`).
*   **Solution**: Use Regex to accept *either* correct value.

```toml
[[labs.checks]]
message = "Password Recovery: Config Register set to 0x2142"
points = 5
device = "HQ-Router"
    [[labs.checks.pass]]
    type = "XmlRegex"
    # Path: <DEVICE><ENGINE><NEXT_CONFIG_REGISTER>
    path = ["NEXT_CONFIG_REGISTER"]
    # Logic: Matches "0x2142" OR "8514"
    value = "^(0x2142|8514)$"
```

### Contexts
Where the grader looks for the config:
*   `global`: Top level (hostname, ip route).
*   `interface [name]`: Inside an interface block (e.g., `interface GigabitEthernet0/0/0`).
*   `router [proto]`: Inside a routing block (e.g., `router ospf 1`).
*   `line [type]`: Inside a line block (e.g., `line vty 0 4`).

> **Important:** When distributing the packet tracer file to students, **ensure the answer network is deleted** inside the PKA activity wizard.

---

## 2. Quizzes (`quiz.conf`)

Defined in `[[quizzes]]` blocks.

### Quiz Question Types

*   **radio**: Single choice.
*   **checkbox**: Multiple correct answers.
*   **text**: Regex-validated text input.
    ```toml
    [[quizzes.questions]]
    text = "Enter the command to save memory:"
    type = "text"
    # Matches "wr" OR "write memory" OR "copy run start"
    regex = "^(wr|write memory|copy run.* start.*)$"
    ```
*   **matching**: Drag and drop terms.

## Server-Sided Security
*   **No Answers on Client**: All grading logic (`grading.js`) runs in a hidden worker thread on the server.
*   **Input Blocking**: Quizzes disable Copy/Paste.
*   **Attempts**: Hard limits on how many times a user can submit.
*   **Sanitized Payloads**: If score display is disabled, the server scrubs the score data from the network packet before sending it to the client.

## Free Servers
*   [Koyeb](https://www.koyeb.com/) and [Render](https://render.com/).
*   Use [cron-job.org](https://console.cron-job.org/login) to ping the server every 10 minutes to prevent sleeping.
