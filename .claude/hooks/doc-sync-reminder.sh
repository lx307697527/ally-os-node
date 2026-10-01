#!/usr/bin/env bash
# PostToolUse hook: after any Edit/Write inside the source tree, remind the
# model to keep the docs that describe that file in sync.
# Ported from ally-os (which watched src/modules/*/CLAUDE.md maps and
# supabase/TABLE-INDEX.md); adapted to this repo's layout and rules:
# schema changes must carry their generated migration, migrations are
# never hand-edited once merged, and docs/ follows the code in the same PR.
# Receives hook JSON on stdin; we only need the file path.
INPUT=$(cat)
FILE=$(echo "$INPUT" | grep -o '"file_path"[^,}]*' | head -1 | sed 's/.*: *"//; s/"$//')

case "$FILE" in
  */packages/db/src/schema.ts)
    echo "{\"systemMessage\": \"Reminder: you edited packages/db/src/schema.ts. Run pnpm db:generate and commit the generated migration in the same PR — CI fails on a schema change without one.\"}"
    ;;
  */packages/db/migrations/*)
    echo "{\"systemMessage\": \"Reminder: you touched a migration. Migrations merged to main are never hand-edited (deploy runs them before rollout); make schema changes in packages/db/src/schema.ts and regenerate.\"}"
    ;;
  */apps/*|*/packages/*)
    echo "{\"systemMessage\": \"Reminder: if this change moves architecture, boundaries or conventions, update docs/architecture/overview.md and AGENTS.md in the same PR.\"}"
    ;;
esac
exit 0
