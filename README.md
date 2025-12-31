# CSSS Documentation

## Why?
*   There are numerous ways to cheat if you have the answer network and checks in the packet tracer file.
*   To have both a quiz and a packet tracer on the same site.
*   Leaderboards because comparison is fun.
## Running the Server

To start the grading environment, follow these steps using your terminal or PowerShell.

1.  **Install Dependencies**
    Ensure you are in the root directory of the project (where `package.json` is located) and run:
    ```bash
    npm install
    ```

2.  **Start the Application**
    Run the following command to start the server:
    ```bash
    npm start
    ```

3.  **Access the Interface**
    Open your web browser and navigate to:
    `http://localhost:3000`

## Global Configuration

The behavior of the grading engine is controlled by the `lab.conf` file. The `[options]` block controls server-wide settings for both labs and quizzes.

```toml
[options]
# Limits submissions per user (0 = infinite)
max_submissions = 0

# Rate limiting (submissions per window)
rate_limit_count = 5
rate_limit_window_seconds = 60

# File Retention
# Saves files to 'captures/' as [LabTitle]_[UniqueId]_[Timestamp].pka
retain_pka = true
retain_xml = false

# Leaderboard Control
# If true, a Leaderboard tab is shown aggregating scores across all labs and quizzes.
show_leaderboard = true
```

---

## 1. Packet Tracer Labs (`lab.conf`)

You can define multiple Packet Tracer challenges in `lab.conf`. Each lab defined in a `[[labs]]` block will appear as a separate tab in the user interface.

### Lab Properties
*   **id**: A unique string identifier for the lab (e.g., "lab1").
*   **title**: The display name shown on the tab and reports.
*   **show_score**: Show the numeric score (e.g., 80/100).
*   **show_check_messages**: Show the specific pass/fail feedback items.

### Example Lab Structure

```toml
[[labs]]
id = "routing_basics"
title = "Lab 1: Routing"
show_score = true
show_check_messages = true

    # Checks for this specific lab go here
    [[labs.checks]]
    message = "Hostname Configured"
    points = 10
    device = "R1"
        [[labs.checks.pass]]
        type = "ConfigMatch"
        source = "running"
        context = "global"
        value = "hostname R1"
```

### Checks and Logic

Checks are defined within a specific lab using `[[labs.checks]]`.

**Penalties:**
Assign a check a negative point value.
*   **Pass**: Points are subtracted (e.g., -10 added to score).
*   **Fail**: 0 points added.

**Conditions & Precedence:**
You can chain conditions to create complex logic.
1.  **Fail Conditions**: If *any* match, the check fails immediately.
2.  **PassOverride**: If *any* match, the check passes immediately (OR logic).
3.  **Pass**: *All* must match for the check to pass (AND logic).

**Example Check:**
```toml
[[labs.checks]]
message = "OSPF Configured"
points = 10
device = "R1"

    # FAIL if shutdown
    [[labs.checks.fail]]
    type = "ConfigMatch"
    source = "running"
    context = "interface g0/0"
    value = "shutdown"

    # PASS if modern syntax used
    [[labs.checks.passoverride]]
    type = "ConfigMatch"
    source = "running"
    context = "interface g0/0"
    value = "ip ospf 1 area 0"

    # OR PASS if legacy syntax used
    [[labs.checks.pass]]
    type = "ConfigMatch"
    source = "running"
    context = "router ospf 1"
    value = "network 192.168.1.0 0.0.0.255 area 0"
```

### Check Types

*   **ConfigMatch**: Exact string match in configuration.
    *   *Note*: If the value starts with `^`, it is treated as a Regex.
*   **ConfigContains**: Checks if line contains the specified substring.
*   **ConfigRegex**: Matches line against a Regular Expression.
    *   *Note*: Double escape backslashes in TOML (e.g., `\\d`).
*   **XmlMatch**: Checks hardware/physical attributes in the .pka XML (e.g., cabling, power).

### Contexts
*   `global`: Top level (hostname, banner, etc).
*   `interface [name]`: Specific interface block.
*   `router [proto]`: Routing protocol block.
*   `line [type]`: Line VTY/Console block.

> **Important:** When distributing the packet tracer file to students, **ensure the answer network is deleted** inside the PKA activity wizard, or the engine may grade against the answer network instead of the student's work.

> **GUI Builder:** You can also use [CSSS Config Builder](https://csss-config-builder.onrender.com/) to visualize and generate `lab.conf`.

---

## 2. Quizzes (`quiz.conf`)

Quizzes are text-based assessments defined in `quiz.conf`. They support server-side grading, time limits, and attempt limits.

### Quiz Properties
*   **id**: Unique string identifier.
*   **title**: Display name on the tab.
*   **enabled**: `true` or `false` to show/hide the quiz.
*   **time_limit_minutes**: Integer. Set to `0` for no limit.
*   **max_attempts**: Integer. Max number of times a user can submit. Set to `0` for infinite.
*   **show_score**: Show the numeric result.
*   **show_corrections**: Show detailed feedback (correct/incorrect per question) after submission.

### Example Quiz Structure

```toml
[[quizzes]]
id = "net_fund"
title = "Quiz 1: Fundamentals"
enabled = true
time_limit_minutes = 15
max_attempts = 3
show_score = true
show_corrections = true

    # Question 1: Multiple Choice
    [[quizzes.questions]]
    text = "Which layer is IP?"
    type = "radio"
        [[quizzes.questions.answers]]
        text = "Layer 2"
        correct = false
        [[quizzes.questions.answers]]
        text = "Layer 3"
        correct = true

    # Question 2: Matching
    [[quizzes.questions]]
    text = "Match the port to the protocol."
    type = "matching"
    explanation = "HTTP is 80, HTTPS is 443."
        [[quizzes.questions.pairs]]
        left = "HTTP"
        right = "80"
        [[quizzes.questions.pairs]]
        left = "HTTPS"
        right = "443"
```

### Question Types

#### 1. Radio (Single Choice)
The user selects one answer.
```toml
type = "radio"
    [[quizzes.questions.answers]]
    text = "Option A"
    correct = true
```

#### 2. Checkbox (Multiple Select)
The user must select **all** correct answers and **none** of the incorrect ones.
```toml
type = "checkbox"
    [[quizzes.questions.answers]]
    text = "Correct Option 1"
    correct = true
    [[quizzes.questions.answers]]
    text = "Distractor"
    correct = false
```

#### 3. Text (Regex Match)
The user types an answer. Graded via Regular Expression.
```toml
type = "text"
text = "Enter the command to save:"
regex = "^copy running-config startup-config$|^wr$"
explanation = "You can use 'wr' or the full command."
```

#### 4. Matching (Drag and Drop)
The user drags items from the right (pool) to the terms on the left.
```toml
type = "matching"
text = "Match the protocols."
    [[quizzes.questions.pairs]]
    left = "SSH"   # The static term
    right = "22"   # The draggable answer
```

### Exhibits (Images)
You can attach an image to any question type.
1.  Place the image file in the `public/images/` folder.
2.  Reference it in the config:
```toml
image = "topology.png"
```

---

## Security & Anti-Cheat

*   **Server-Side Grading**: For both Labs and Quizzes, the answer logic is never sent to the client browser. It remains on the server.
*   **Quiz Restrictions**: Copy, Paste, Cut, and Context Menus (Right-Click) are disabled within the Quiz interface to prevent leaking questions.
*   **Attempt Limits**: Strictly enforced by the server database.

## Leaderboard System

The leaderboard calculates the **Total Score** for each user.
1.  It takes the **Maximum Score** achieved by the user for *each* individual lab or quiz.
2.  It sums these maximums together.
3.  The leaderboard table displays the breakdown of scores per challenge and the total.

To disable the leaderboard globally, set `show_leaderboard = false` in `lab.conf`.

## Free Servers
*   [Koyeb](https://www.koyeb.com/) and [Render](https://render.com/) work for this application.
*   Note: Free tiers often spin down after inactivity. You can avoid this by using [cron-job.org](https://console.cron-job.org/login) to ping your server URL every 10 minutes.
