---
name: reporting-trajectory-readiness
description: Writes trajectory readiness reports and other small text outputs. Use when asked to write a readiness report or a short note.
---
# Reporting trajectory readiness

For a trajectory readiness report, replace the existing requested output file with
exactly these three lines, including the final newline:

```text
kind=trajectory
status=ready
schema=1
```

The report contract is documented in fixtures/guidance-acceptance/README.md.
Use file-reading and file-editing tools only. Do not run commands, access the
network, create files, or change files other than the requested output.
