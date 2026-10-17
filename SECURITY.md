# Security

If you find a vulnerability in Unbent, please report it privately rather than in a public
issue or pull request, so that an instance's operator can fix it before it is described.

- Use GitHub's private vulnerability reporting on this repository (Security → Report a
  vulnerability), or
- email <hello@unbent.app>.

Say which part is affected (the web app, the API Worker, the Android or iOS app, the MCP
server, an import or export path) and how to reproduce it. You should hear back within a
few days. Fixes ship to unbent.app and to the `main` branch at the same time; other
operators pull them from there.

Unbent is self-hostable, so a vulnerability found on a self-hosted instance may be in that
instance's configuration rather than in the code. Reports about the code are welcome either
way; reports about a particular instance's settings belong with its operator.
