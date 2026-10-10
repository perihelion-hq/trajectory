---
name: reporting-trajectory-readiness
description: Writes trajectory readiness reports. Use when asked to generate or write a trajectory readiness report. Do not use for unrelated short notes or general text outputs.
---
# Reporting trajectory readiness

For a trajectory readiness report, replace the existing requested output file with
exactly these three lines, including the final newline:

kind=trajectory
status=ready
schema=2

The report contract is documented in fixtures/guidance-acceptance/README.md.
Use file-reading and file-editing tools only. Do not run commands, access the
network, create files, or change files other than the requested output.
