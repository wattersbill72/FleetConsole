# DEC-001: Operator identity (OD-3)

Status: Accepted. Date: 2026-11-24.

Decision: Fleet Console has its own IAM store. It copies the KPTR pattern (Node `crypto.scrypt`, opaque server-side session tokens in cookies, organisation scoping in the API layer, no Postgres RLS). It shares no database or sessions with the Clarix apps.

Reasoning: the console must stay up when the apps it monitors are down; a shared identity store couples their failures. One operator, one organisation at launch.

Extension point: sign-in sits behind a small provider interface (local password now). Entra ID / Active Directory (OIDC) is added later as a second provider without schema change to sessions or audit events. Not built in R1.
