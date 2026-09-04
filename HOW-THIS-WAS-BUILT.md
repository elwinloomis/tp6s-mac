# How this was built

This toolkit was developed by a person working with
[Claude Code](https://claude.com/claude-code). The agent helped inspect the
protocol, implement the software and analyse measurements; the hardware owner
set the product direction and tested the output on paper.

That last step changed important decisions. Long prints revealed a silent
printer-buffer overflow that telemetry did not show, physical type specimens
favoured heavier and rougher faces than screen previews suggested, and real
documents showed that page orientation must follow the source page rather
than the shape of its ink. Weeks later a page half the size of a proven one
came out short, and the fix that stuck was found by counting the motor's
stops against the printer's own status frames — the flow-control signal the
earlier notes had said did not exist. The resulting rule is simple: software
hypotheses are useful, but hardware behaviour wins. The repeatable
measurements are in [`INVESTIGATION.md`](INVESTIGATION.md).
