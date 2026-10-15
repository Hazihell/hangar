---
name: gh-release
description: Creates a new GitHub release. Applies pending production database migrations first when the repo ships them, then bumps the version in package.json, commits the change, and creates the release on GitHub. You can specify if it's a major, minor, or patch release (defaults to patch).
---

# GitHub Release Skill

This skill automates the process of creating a new GitHub release.

## Workflow

1. **Determine bump type**.
   - `major`: breaking changes.
   - `minor`: new features.
   - `patch`: bug fixes. This is the default.

2. **Apply pending database migrations to production before tagging**, when the repository ships migrations (a `drizzle/`, `migrations/` or `prisma/migrations/` directory). The deploy that follows the tag runs the new code against the database as it is, and code that reads a table its migration creates fails closed until that migration lands.
   - Follow the recipe in the repository's deploy doc (`docs/deploy.md`, Migrations section). When the doc says the platform applies migrations on deploy, this step is already done.
   - Run the migration from the checkout of the commit being released, with the production connection string passed inline for that one command. Credentials are read at run time and stay out of files, shell history and the final response.
   - Done when the production migrations table lists every migration file in the checkout, and every tunnel or forwarder opened for the step is closed again.

3. **Run the release script from the target repository root**.
   - The script file lives in this skill at `scripts/create-release.js`.
   - The current working directory must be the project being released.
   - The script reads and updates the target project's `package.json` from the current working directory.

4. **Validate release prerequisites**.
   - Confirms the current directory is the git repository root.
   - Confirms the working tree is clean before changing the version.
   - Confirms `gh` authentication is available before creating the release.

5. **Create the release**.
   - Bumps the version in the target project's `package.json`.
   - Generates a descriptive release title based on the most relevant commits and appends the version as `(... v<new_version>)`.
   - Commits the version bump with `chore(release): <generated_release_title>`.
   - Creates an annotated git tag named `v<new_version>` using the same generated release title as the tag message.
   - Pushes the commit and tag.
   - Creates a GitHub release with the generated title and a structured changelog built from commits since the previous tag.
   - End the response with a short summary of what shipped. A project may carry its own release skill that fixes the language, voice and audience of that summary and adds steps before this one; when it exists, follow it.

## Usage

Run the script from the repository you want to release:

```bash
node /path/to/gh-release/scripts/create-release.js
node /path/to/gh-release/scripts/create-release.js patch
node /path/to/gh-release/scripts/create-release.js minor
node /path/to/gh-release/scripts/create-release.js major
```

Example with this skill installed locally:

```bash
node ~/.agents/skills/gh-release/scripts/create-release.js patch
```

## Release Notes

The generated release notes group commits into sections such as Features, Fixes, Performance, Refactors, and Maintenance. When a previous version tag exists, the release notes also include a compare link for the full diff.

Commit messages written in conventional-commit style produce the best changelog output.

## Release Title

The generated release title is derived from the most relevant conventional commit since the previous tag.

- `feat` commits are preferred first, followed by `fix`, `perf`, `refactor`, and maintenance-oriented types.
- If the top commit has a scope, the title uses that scope for readability.
- The version is always appended to the final title in the form `(v<new_version>)`.
- The same title is reused for the release commit, annotated tag message, and GitHub release title.
- A squash-merged pull request arrives as one commit with no conventional type, so the script skips it and titles the release after a lesser commit. When the release's substance is such a PR, rename the release after the PR title with `gh release edit <tag> --title ... --notes-file ...` and expand the notes with the PR's highlights; the commit and tag keep the generated title.

## Project Wrappers

This skill is project-agnostic: bump, tag, push, publish. Anything a repository needs around that (a user-facing changelog entry, a summary in a given language, a deploy step) belongs in a skill inside that repository which prepares the tree, then invokes this one. Do not add project-specific rules here.
