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

## Configuration Fields

The behavior of the grading engine is controlled by the `lab.conf` file. These options go in the `[options]` block or at the top level of the file.

**show_check_messages**: Determines if the specific messages for passed or failed checks are displayed to the user in the report.

```toml
show_check_messages = true
```

**show_score**: Determines if the numeric score (e.g., 50/100) is displayed to the user.

```toml
show_score = true
```

**retain_pka**: If true, the server saves the original `.pka` file uploaded by the student to the `captures` directory.

```toml
retain_pka = true
```

**retain_xml**: If true, the server saves the decrypted `.xml` file to the `captures` directory. This is useful for debugging hardware paths during lab creation.

```toml
retain_xml = false
```

**max_submissions**: Sets a hard limit on how many times a specific user can submit files. Set to `0` for infinite submissions.

```toml
max_submissions = 0
```

**rate_limit_count**: The number of submissions allowed within a specific time window. Used to prevent spam or brute-forcing.

```toml
rate_limit_count = 5
```

**rate_limit_window_seconds**: The duration (in seconds) for the rate limit window.

```toml
rate_limit_window_seconds = 60
```

**title**: The title of the lab activity, displayed in the report header.

```toml
title = "CCNA Security Final"
```

## Penalties

Assign a check a negative point value, and it will become a penalty.

If the check **passes** (the condition is found), the negative points are added to the score (subtracting from the total).
If the check **fails** (the condition is NOT found), 0 points are added.

Example:

```toml
[[check]]
message = "Security Violation: HTTP Server Enabled"
points = -10
device = "R1"

    # If this line is found, the user loses 10 points
    [[check.pass]]
    type = "ConfigMatch"
    source = "running"
    context = "global"
    value = "ip http server"
```

## Check Conditions and Precedence

Using multiple conditions for a check allows for complex logic, such as allowing alternative configurations or ensuring absolute restrictions.

Given no conditions, a check does not pass.

If any **Fail** conditions succeed, the check does not pass.

**PassOverride** conditions act as a logical OR. This means that any can succeed for the check to pass.

**Pass** conditions act as a logical AND. This means they must ALL be true for a check to pass.

If the outcome of a check is decided, the engine will NOT execute the remaining conditions (it will "short circuit"). For example, if a PassOverride succeeds, any Pass conditions are NOT executed.

The evaluation goes like this:
1. Check if any Fail conditions are true. If any Fail checks succeed, then we are done, the check doesn't pass.
2. Check if any PassOverride conditions pass. If they do, we are done, the check passes.
3. Check status of all Pass conditions. If they all succeed, the check passes, otherwise it fails.

Example:

```toml
[[check]]
message = "R1 OSPF Configuration"
points = 10
device = "R1"

    # FAIL if the interface is shutdown
    [[check.fail]]
    type = "ConfigMatch"
    source = "running"
    context = "interface GigabitEthernet0/0"
    value = "shutdown"

    # PASS immediately if OSPF is on the interface (Modern style)
    [[check.passoverride]]
    type = "ConfigMatch"
    source = "running"
    context = "interface GigabitEthernet0/0"
    value = "ip ospf 1 area 0"
    
    # OR pass if Network command is used (Classic style)
    [[check.pass]]
    type = "ConfigMatch"
    source = "running"
    context = "router ospf 1"
    value = "network 192.168.1.0 0.0.0.255 area 0"
```

## Checks

This is a list of check types available in the grading engine.

**ConfigMatch**: Pass if the configuration line exists exactly as written.

```toml
type = "ConfigMatch"
value = "hostname Router1"
```

> **Note**: If the value starts with `^`, it is treated as a Regex.

**ConfigContains**: Pass if the configuration line contains the specified substring.

```toml
type = "ConfigContains"
value = "Staff Network"
```

> Useful for descriptions where whitespace or exact casing might vary.

**ConfigRegex**: Pass if the configuration line matches the provided Regular Expression.

```toml
type = "ConfigRegex"
value = "^enable secret 5 \\$1\\$.*"
```

> **Note**: You must double-escape backslashes in TOML strings (e.g. `\\d` for a digit).

**XmlMatch**: Pass if the raw XML value at the specified path equals the value. Used for hardware checks (cabling, power, modules).

```toml
type = "XmlMatch"
path = ["MODULE", "0", "SLOT", "0", "PORT", "0", "BANDWIDTH", "0"]
value = "1000000"
```

> **Note**: The path is an array of strings. Even array indices in the XML (like 0) must be passed as strings (e.g., `"0"`).

## Contexts and Sources

When using Config checks (`ConfigMatch`, `ConfigContains`, `ConfigRegex`), you must specify the **source** and **context**.

### Sources

**running**: Checks the active Running Configuration (RAM).

```toml
source = "running"
```

**startup**: Checks the Startup Configuration (NVRAM). Use this to ensure students have saved their configurations.

```toml
source = "startup"
```

### Contexts

**global**: Top-level commands.

```toml
context = "global"
# Matches: hostname, banner, ip route, etc.
```

**interface**: Specific interface blocks.

```toml
context = "interface GigabitEthernet0/0"
# Matches: ip address, description, shutdown
```

> The engine normalizes whitespace, so `interface g0/0` may match `interface GigabitEthernet0/0` depending on internal mapping, but it is safest to use the full name as it appears in the `show run` output.

**router**: Routing protocol blocks.

```toml
context = "router ospf 1"
# Matches: network, auto-cost, passive-interface
```

**line**: Console or VTY line blocks.

```toml
context = "line vty 0 4"
# Matches: password, login local, transport input ssh
```
