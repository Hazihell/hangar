---
name: gcommit
description: Generates and executes a conventional commit message based on staged changes and project history. Use when asked to 'gcommit', 'commit changes', or generate a commit message.
---

# Gcommit

## Overview

This skill guides the agent to generate high-quality, Conventional Commits messages by analyzing **only the currently staged changes** and the project's commit history. It ensures consistency and clarity in the project's version control history.

## Constraints

- **Scoped Automatic Staging**: If the index is empty, inspect the working tree and stage only the coherent changes that belong to the user's active request. Preserve unrelated, ambiguous, generated, and sensitive files. If the intended scope cannot be determined safely, ask before staging.
- **Respect Existing Staging**: If the index already contains changes, commit only those changes unless the user explicitly asks to expand the scope.
- **NO --no-verify**: NEVER use the `--no-verify` (or `-n`) flag. Commits must ALWAYS run pre-commit hooks.

## Workflow

1.  **Check Status**: Verify that there are staged changes to commit.
    - Run: `git diff --cached`
    - If the output is empty:
      - Inspect unstaged and untracked changes with `git status --short` and the relevant diffs.
      - If coherent changes clearly belong to the active request, stage only those paths with explicit `git add -- <paths>` arguments.
      - If no changes exist, report that there is nothing to commit and stop.
      - If scope is ambiguous or includes unrelated changes, ask the user before staging those paths.
      - Re-run `git diff --cached` and `git status --short` to verify the resulting boundary.

2.  **Gather Context**:
    - Retrieve the staged changes (content to be committed).
    - Retrieve recent commit history to match style/scope conventions.
    - Run: `git log -n 5 --pretty=format:%s`

3.  **Generate Message**:
    - Analyze the `git diff --cached` output.
    - Draft a commit message using the **Conventional Commits** format.

    **Strict Format Rules:**
    1.  **Header**: `<type>(<scope>): <short summary>` (e.g., `feat(auth): add google oauth provider`)
    2.  **Body**: Separated from header by a blank line.
    3.  **Details**: A bulleted list (-) explaining the *why* and *what* of the changes.
    4.  **Tense**: Use present tense (e.g., "add" not "added").
    5.  **Style**: Match the capitalization and scoping style observed in the `git log` history.
    6.  **No PR Templates**: DO NOT include PR-style sections such as "Description", "Changelog", "How to test", or "Sherlock associated ticket". Keep the message clean and focused on the code changes themselves.

4.  **Execute**:
    - If a multi-option question tool is available in the current environment, use it to present the user with concise choices to confirm, decline, or receive the proposed commit message prompt.
    - If that tool is not available, run the commit directly with `git commit -m "THE_GENERATED_MESSAGE"`.
    - Do not suggest pushing, and never include `--no-verify`.
    - After the commit, report the commit hash and a short confirmation.

## Examples

**Input:**
- Staged: Added `passport-google-oauth20` to package.json, updated `auth.service.ts`.
- History: `feat(api): add login endpoint`, `fix(ui): button alignment`

**Output:**
```bash
git commit -m "feat(auth): add google oauth provider

- Integrated passport-google-oauth20 strategy.
- Added new environment variables for client ID and secret.
- Updated login UI with Google button."
```

**Result:**
- Commit created successfully.
- Commit hash: `abc1234`
