#!/usr/bin/env bash
# PostToolUse hook: after an Edit/Write to a source file, remind the model to
# check LSP diagnostics for that file (via the LSP-over-MCP server) and clear
# any type/resolution errors BEFORE running the test suite. Cheap-before-expensive.
# This hook does not run the language server itself — it nudges; the actual
# diagnostics come from the `serena`/LSP MCP tools (see docs/zh-CN/CODE-INTELLIGENCE.md).
# Receives hook JSON on stdin; we only need the file path.
INPUT=$(cat)
FILE=$(echo "$INPUT" | grep -o '"file_path"[^,}]*' | head -1 | sed 's/.*: *"//; s/"$//')

case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.py|*.go|*.rs)
    echo "{\"systemMessage\": \"Reminder: you edited a source file. Before VERIFY, query LSP diagnostics for it (LSP MCP tool) and clear any type/unresolved-symbol errors first — do not run the test suite on code that doesn't type-check.\"}"
    ;;
esac
exit 0
