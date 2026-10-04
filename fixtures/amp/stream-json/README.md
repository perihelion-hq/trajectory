# Amp `--stream-json` captures

Unedited stdout of two real Amp CLI runs (`amp 0.0.1791107882-gfe04cc`), taken on 2026-10-04 in an
E2B sandbox with Roster's `roster-harness` plugin agent mode (`amp -x --mode roster-harness
--stream-json --dangerously-allow-all`), one per model, with the prompt "Run `ls` in the workspace
with the shell tool, then reply with the file names." Both threads were deleted after capture.

Neither terminal `result` record carries `usage`; every assistant record carries `message.usage`.
Amp's schema (https://ampcode.com/docs/cli/streaming-json) marks `usage` optional on both.
