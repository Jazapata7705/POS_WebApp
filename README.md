# 331-squad-80-pos
Jira Board:
https://csce-project3.atlassian.net/jira/software/projects/CWPA/boards/4/backlog

## Kitchen display (`/kitchen`)
- Needs `KITCHEN_PASSWORD_HASH` in `.env`, in the same `salt:hash` scrypt format as `MANAGER_PASSWORD_HASH`.
- Database columns (`orders.completed_at`, `orders.started_at`, `orderdetail.completed_at`) are already added to the shared `squad_80_db`. `db/2026-11-09-kitchen-completed-at.sql` records the change; run it only on a fresh database.
