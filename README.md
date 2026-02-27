# CSSS Documentation

## Why?
*   **Anti-Cheat**: Keeps answers on the server, not in the file.
*   **Unified**: Labs and Quizzes in one place.
*   **Competition**: Live leaderboards.

## Running the Server
1.  `npm install`
2.  `node quickstart.js` (Interactive Setup)
3.  `npm start`
4.  Access at `http://localhost:3000`

---

## 1. Packet Tracer Labs (`lab.conf`)

Defined in `[[labs]]` blocks.

### Lab Settings
You can customize resource usage and attempt limits per lab:
```toml
[[labs]]
id = "lab1_basic"
title = "Basic Lab"
max_submissions = 3
max_upload_mb = 10
max_xml_output_mb = 150
rate_limit_count = 5
rate_limit_window_seconds = 60
```

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

### Contexts
Where the grader looks for the config:
*   `global`: Top level (hostname, ip route).
*   `interface [name]`: Inside an interface block.
*   `router [proto]`: Inside a routing block.

> **Important:** When distributing the packet tracer file to students, **ensure the answer network is deleted** inside the PKA activity wizard.

---

## 2. Quizzes (`quiz.conf`)

Defined in `[[quizzes]]` blocks.

### Quiz Question Types

*   **radio**: Single choice.
*   **checkbox**: Multiple correct answers.
*   **text**: Regex-validated text input.
*   **matching**: Drag and drop terms.

### Quiz Exhibits (Images & PKA Files)
You can attach an image or a downloadable `.pka` file to **any** question.

To prevent cheating (IDOR/URL guessing), assets must be placed inside the **`protected/`** directory at the root of your server, *not* in the public folder.
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
*   **No Answers on Client**: All grading logic (`grading.js`) runs in a hidden worker thread on the server.
*   **Input Blocking**: Quizzes disable Copy/Paste, and lock inputs permanently upon submission to prevent tampering.
*   **Protected Assets**: Quiz Exhibits (Images/PKA) are hidden behind a secure API. They cannot be downloaded unless the user is logged in, and the file belongs to an actively `enabled` quiz.
*   **Sanitized Payloads**: If score display is disabled, the server scrubs the score data entirely from the socket stream.
*   **TOCTOU Mitigations**: Global memory locks prevent race-condition exploits to bypass `max_submissions`.