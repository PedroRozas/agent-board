# Changelog

## 0.3.0

### Added

- Subagent detail. Open any subagent from the session detail, in the dashboard or in the pane, to see the prompt it was given, its own tool log and its final answer. In the text view, `/agent-board <session>.<agent>` prints the same, such as `/agent-board 2.1`.
- A running subagent is flagged when a tool has been running for 3 minutes, when it has shown no activity for 3 minutes, or after 3 failed tools in a row.

### Fixed

- Opening a session no longer logs `skipped … (SyntaxError: JSON Parse error …)` for the files of other active sessions. Sessions now publish their snapshot to a temporary file and rename it into place, so a reader never sees a half-written file.
- A session no longer disappears from the board for one refresh when its file cannot be read. The board keeps its last snapshot, and the error is logged only when it happens on two refreshes in a row. The web dashboard does the same.
- Temporary files left behind by a crashed session are removed after 24 hours, like old session files.

### Changed

- The plugin is now installed from the shared marketplace `PedroRozas/claude-plugins` instead of `PedroRozas/agent-board`.
- Snapshot files now include the first 2,000 characters of each subagent's prompt and of its final answer.

## 0.2.3

### Added

- Session snapshots live in private folders. On macOS and Linux, `~/.claude/agent-board` and its `sessions` folder are created with mode `700`, so other users on the machine cannot read prompt excerpts or shell commands. On Windows the files keep the permissions of your user profile. If the folders cannot be made private, the reason is logged and the session keeps working.

### Changed

- Diagnostic messages are in English, whatever language the board uses.
- The README opens with a live demo of the dashboard and says that the web view needs Node while the pane and text views need nothing.

## 0.2.1

### Added

- First tagged release: a live board of every Claude Code session on your machine, as a local web dashboard, a pane docked inside Claude Code and a text view that works over SSH and in headless sessions.
- Current request and tool, subagents and their tasks, context used, cost and tokens per model for each session.
- The 5-hour and weekly rate limits, with a pace marker.
- English and Spanish, a configurable port, and language and theme selectors in the dashboard.

### Fixed

- A stray "null" under the timeline and in the plan header when there are no rate limits.
- The selected session row repeating its highlight on every cell.

### Changed

- The dashboard no longer loads Google Fonts. It uses system fonts and makes no requests to the internet.
