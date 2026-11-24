# US-011 — Install the Edge Agent on an Ubuntu node

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R1

As the operator, I want one command to install and start the agent on Ubuntu 24.04 so that a machine reports within minutes.

**Acceptance criteria**

- Running the command from US-010 on a clean Ubuntu 24.04 machine installs the agent, enrols it, and starts it with no further prompts beyond privilege elevation.
- The agent is registered with the operating system's service manager, starts at boot, and restarts after a crash.
- The node appears in the console as `pending` at enrolment and `healthy` after the first heartbeat, within five minutes of running the command.
- The node receives a generated permanent identity. Renaming the machine afterward changes the displayed hostname and nothing else.
- The agent's credential and configuration are readable only by the agent's own account.
- Running the installer on a machine that already has an agent reports the existing installation and changes nothing unless I ask for reinstall or upgrade.
- The installer ends by printing: node identity, farm, console address, service status, and how to remove the agent.
- A failed install leaves no partial installation behind.

**Depends on:** US-010
