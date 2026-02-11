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

### Lab Check Types

You can append **`Not`** to any check type to invert the logic (Pass if the condition is **FALSE**).

#### 1. ConfigMatch / ConfigMatchNot
Checks if a specific line exists (or does not exist) exactly as written.

**Example: Simple hostname check**
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

#### 2. ConfigRegex / ConfigRegexNot
Checks if a line matches (or does not match) a Regex pattern.

**Example: Remove unauthorized user Adam**
```toml
[[labs.checks]]
message = "No Test Users Allowed"
points = 5
device = "R1"
    [[labs.checks.pass]]
    type = "ConfigMatchNot"
    source = "running"
    context = "global"
    value = "username Adam"
```

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
Checks if an XML value matches a pattern.

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

### Quiz Images (Exhibits)
You can attach an image to **any** question type.
1.  Place the image file in the `public/images/` folder.
2.  Reference it in the config using the `image` key.

```toml
[[quizzes.questions]]
text = "Identify the network topology shown."
type = "radio"
image = "topology.png" # Automatically loads from public/images/topology.png
    [[quizzes.questions.answers]]
    text = "Star"
    correct = true
```

## Server-Sided Security
*   **No Answers on Client**: All grading logic (`grading.js`) runs in a hidden worker thread on the server.
*   **Input Blocking**: Quizzes disable Copy/Paste.
*   **Attempts**: Hard limits on how many times a user can submit.
*   **Sanitized Payloads**: If score display is disabled, the server scrubs the score data from the network packet before sending it to the client.

## Free Servers
*   [Koyeb](https://www.koyeb.com/) and [Render](https://render.com/).
*   Use [cron-job.org](https://console.cron-job.org/login) to ping the server every 10 minutes to prevent sleeping.
