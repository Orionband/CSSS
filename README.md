# CSSS Documentation

## Running the Server

1.  **Install Dependencies**
    ```bash
    npm install
    ```

2.  **Start the Application**
    ```bash
    npm start
    ```

3.  **Access the Interface**
    `http://localhost:3000`

## Security Features
*   **Anti-Cheat (Quizzes)**: The quiz interface disables Copy, Paste, Cut, and Context Menus (right-click) to prevent leaking questions or pasting answers.
*   **Attempt Limits**: Instructors can set `max_attempts` in `quiz.conf`.
*   **Server-Side Grading**: Answers are never sent to the client browser.

## Configuration Files

### 1. Labs (`lab.conf`)
Standard Packet Tracer grading logic.

### 2. Quizzes (`quiz.conf`)
Text-based quiz definitions.

```toml
[[quizzes]]
id = "quiz1"
title = "Quiz 1"
enabled = true
time_limit_minutes = 20
max_attempts = 1 # Single attempt only
show_score = true
show_corrections = true

    [[quizzes.questions]]
    text = "Question text..."
    type = "radio"
    # ...
```

## Question Types
*   **radio**: Multiple choice (single).
*   **checkbox**: Multiple select.
*   **text**: Text input (Regex).
*   **matching**: Drag and drop terms to definitions.
