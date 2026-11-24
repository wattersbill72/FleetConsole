# US-051 — Query node logs from the console

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R4

As the operator, I want to read and filter a node's logs in the console so that I can diagnose a problem without opening a terminal.

**Acceptance criteria**

- From a node or service I open logs filtered to that subject, and can change time range, severity, and text filter.
- Results stream into the view and can be followed live.
- No log content is written to the console's database; a test proves it.
- Each query is an audit event recording who, which subject, and which filters, without the results.
- When the farm is unreachable, the view says so plainly and shows the stored error tails for the subject.
- Large result sets are paged or capped with a clear message; the browser stays responsive.

**Depends on:** US-050
