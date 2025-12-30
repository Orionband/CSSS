# CSSS Documentation

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

The behavior of the grading engine is controlled by the `lab.conf` file. The `[options]` block controls server-wide settings.

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
# If true, a Leaderboard tab is shown aggregating scores across all labs.
show_leaderboard = true
```

## Defining Labs (Multi-Lab Support)

You can define multiple challenges/labs in a single config file. Each lab defined in a `[[labs]]` block will appear as a separate tab in the user interface.

### Lab Properties
*   **id**: A unique string identifier for the lab (no spaces recommended, e.g., "lab1").
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

## Leaderboard System

The leaderboard calculates the **Total Score** for each user.
1.  It takes the **Maximum Score** achieved by the user for *each* individual lab.
2.  It sums these maximums together.
3.  The leaderboard table displays the breakdown of scores per lab and the total.

To disable the leaderboard globally, set `show_leaderboard = false` in the `[options]` block.

## Checks and Logic

Checks are defined within a specific lab using `[[labs.checks]]`.

### Penalties
Assign a check a negative point value.
*   **Pass**: Points are subtracted (e.g., -10 added to score).
*   **Fail**: 0 points added.

### Conditions & Precedence
You can chain conditions to create complex logic.

1.  **Fail Conditions**: If *any* match, the check fails immediately.
2.  **PassOverride**: If *any* match, the check passes immediately (OR logic).
3.  **Pass**: *All* must match for the check to pass (AND logic).

**Example:**
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

## Check Types

**ConfigMatch**: Exact string match in configuration.
```toml
type = "ConfigMatch"
value = "hostname R1"
# Start with ^ for regex: value = "^hostname R.*"
```

**ConfigContains**: Checks if line contains substring.
```toml
type = "ConfigContains"
value = "description Link to ISP"
```

**ConfigRegex**: Matches line against a Regular Expression.
```toml
type = "ConfigRegex"
value = "^enable secret 5 \\$1\\$.*"
# Note: Double escape backslashes in TOML
```

**XmlMatch**: Checks hardware/physical attributes in the .pka XML.
```toml
type = "XmlMatch"
path = ["MODULE", "0", "SLOT", "0", "PORT", "0"]
value = "1000"
```

## Contexts

When using Config checks, `context` defines where to look.

*   `global`: Top level (hostname, banner, etc).
*   `interface [name]`: Specific interface block.
*   `router [proto]`: Routing protocol block.
*   `line [type]`: Line VTY/Console block.

## Free Servers
*    [Koyeb](https://www.koyeb.com/) and [Render](https://render.com/) work for this, but both will shut off after a certain amount of time, but you can avoid this by using [cron-job](https://console.cron-job.org/login)