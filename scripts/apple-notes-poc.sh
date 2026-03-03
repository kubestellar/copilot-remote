#!/bin/bash
# Apple Notes Integration - Proof of Concept
# Demonstrates read/write access to Apple Notes via osascript
# Usage: ./apple-notes-poc.sh [list|read|add|toggle|create]

set -euo pipefail

NOTE_NAME="remote"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}[apple-notes]${NC} $1"; }
ok()  { echo -e "${GREEN}✓${NC} $1"; }
warn(){ echo -e "${YELLOW}⚠${NC} $1"; }
err() { echo -e "${RED}✗${NC} $1"; }

# 1. List all notes
cmd_list() {
    log "Listing all notes..."
    osascript -e 'tell application "Notes"
        set noteNames to {}
        repeat with f in every folder
            repeat with n in every note of f
                set end of noteNames to (name of n) & " [" & (name of f) & "]"
            end repeat
        end repeat
        set AppleScript'\''s text item delimiters to linefeed
        return noteNames as text
    end tell'
}

# 2. Check if "remote" note exists
note_exists() {
    osascript -e "tell application \"Notes\"
        try
            get note \"${NOTE_NAME}\"
            return true
        on error
            return false
        end try
    end tell" 2>/dev/null
}

# 3. Create the "remote" note with initial content
cmd_create() {
    if [ "$(note_exists)" = "true" ]; then
        warn "Note '${NOTE_NAME}' already exists"
        return 0
    fi
    log "Creating note '${NOTE_NAME}'..."
    osascript -e "tell application \"Notes\" to make new note with properties {name:\"${NOTE_NAME}\", body:\"<div><b><span style=\\\"font-size: 24px\\\">${NOTE_NAME}</span></b></div><div><br></div><div>Checklist managed by copilot-remote</div><div><br></div><div>Items:</div><ul class=\\\"Apple-dash-list\\\"><li>☐ Example task</li></ul>\"}" >/dev/null
    ok "Note '${NOTE_NAME}' created"
}

# 4. Read note content (returns raw HTML)
cmd_read_raw() {
    osascript -e "tell application \"Notes\" to get body of note \"${NOTE_NAME}\"" 2>/dev/null
}

# 5. Read and parse checklist items
cmd_read() {
    log "Reading checklist from '${NOTE_NAME}'..."
    local body
    body=$(cmd_read_raw)

    if [ -z "$body" ]; then
        err "Could not read note '${NOTE_NAME}'"
        return 1
    fi

    echo ""
    echo "=== Checklist Items ==="
    # Parse checklist items: lines containing ☐ (unchecked) or ☑ (checked)
    echo "$body" | sed 's/<[^>]*>//g' | grep -E '☐|☑' | while IFS= read -r line; do
        line=$(echo "$line" | xargs) # trim whitespace
        if echo "$line" | grep -q '☑'; then
            echo -e "  ${GREEN}${line}${NC}"
        else
            echo -e "  ${YELLOW}${line}${NC}"
        fi
    done
    echo "======================="
    echo ""
}

# 6. Add a new checklist item
cmd_add() {
    local item="${1:-}"
    if [ -z "$item" ]; then
        err "Usage: $0 add \"item text\""
        return 1
    fi

    log "Adding item: ${item}"
    local body
    body=$(cmd_read_raw)

    # Insert new <li> before closing </ul>
    local new_item="<li>☐ ${item}</li>"
    if echo "$body" | grep -q '</ul>'; then
        local updated
        updated=$(echo "$body" | sed "s|</ul>|${new_item}</ul>|")
        osascript -e "tell application \"Notes\" to set body of note \"${NOTE_NAME}\" to \"$(echo "$updated" | sed 's/"/\\"/g')\"" 2>/dev/null
        ok "Added: ☐ ${item}"
    else
        # No list yet — append one
        local updated="${body}<ul class=\"Apple-dash-list\"><li>☐ ${item}</li></ul>"
        osascript -e "tell application \"Notes\" to set body of note \"${NOTE_NAME}\" to \"$(echo "$updated" | sed 's/"/\\"/g')\"" 2>/dev/null
        ok "Added: ☐ ${item} (created new list)"
    fi
}

# 7. Toggle a checklist item by substring match
cmd_toggle() {
    local search="${1:-}"
    if [ -z "$search" ]; then
        err "Usage: $0 toggle \"item substring\""
        return 1
    fi

    log "Toggling item matching: ${search}"
    local body
    body=$(cmd_read_raw)

    if echo "$body" | grep -q "☐.*${search}"; then
        local updated
        updated=$(echo "$body" | sed "s|☐\(.*${search}\)|☑\1|")
        osascript -e "tell application \"Notes\" to set body of note \"${NOTE_NAME}\" to \"$(echo "$updated" | sed 's/"/\\"/g')\"" 2>/dev/null
        ok "Checked: ${search}"
    elif echo "$body" | grep -q "☑.*${search}"; then
        local updated
        updated=$(echo "$body" | sed "s|☑\(.*${search}\)|☐\1|")
        osascript -e "tell application \"Notes\" to set body of note \"${NOTE_NAME}\" to \"$(echo "$updated" | sed 's/"/\\"/g')\"" 2>/dev/null
        ok "Unchecked: ${search}"
    else
        err "No item matching '${search}' found"
        return 1
    fi
}

# 8. Get note modification date (for polling/sync)
cmd_modified() {
    osascript -e "tell application \"Notes\" to get modification date of note \"${NOTE_NAME}\"" 2>/dev/null
}

# 9. Export as JSON (for API integration)
cmd_json() {
    local body
    body=$(cmd_read_raw)
    local mod_date
    mod_date=$(cmd_modified)

    echo "{"
    echo "  \"note\": \"${NOTE_NAME}\","
    echo "  \"modified\": \"${mod_date}\","
    echo "  \"items\": ["

    local first=true
    echo "$body" | sed 's/<[^>]*>//g' | grep -E '☐|☑' | while IFS= read -r line; do
        line=$(echo "$line" | xargs)
        local checked="false"
        local text="$line"
        if echo "$line" | grep -q '☑'; then
            checked="true"
            text=$(echo "$line" | sed 's/☑ //')
        else
            text=$(echo "$line" | sed 's/☐ //')
        fi
        if [ "$first" = "true" ]; then
            first=false
        else
            echo ","
        fi
        printf '    {"text": "%s", "checked": %s}' "$text" "$checked"
    done
    echo ""
    echo "  ]"
    echo "}"
}

# Main
case "${1:-demo}" in
    list)
        cmd_list
        ;;
    create)
        cmd_create
        ;;
    read)
        cmd_read
        ;;
    raw)
        cmd_read_raw
        ;;
    add)
        cmd_add "${2:-}"
        ;;
    toggle)
        cmd_toggle "${2:-}"
        ;;
    modified)
        cmd_modified
        ;;
    json)
        cmd_json
        ;;
    demo)
        echo "==========================================="
        echo " Apple Notes Integration - POC Demo"
        echo "==========================================="
        echo ""

        # Step 1: Ensure note exists
        log "Step 1: Ensure '${NOTE_NAME}' note exists"
        cmd_create
        echo ""

        # Step 2: Read current content
        log "Step 2: Read current checklist"
        cmd_read
        echo ""

        # Step 3: Add a new item
        TIMESTAMP=$(date +%H:%M:%S)
        log "Step 3: Add a new checklist item"
        cmd_add "POC test item at ${TIMESTAMP}"
        echo ""

        # Step 4: Read updated content
        log "Step 4: Read updated checklist"
        cmd_read
        echo ""

        # Step 5: Show JSON output
        log "Step 5: JSON export (for API integration)"
        cmd_json
        echo ""

        # Step 6: Show modification date
        log "Step 6: Modification date (for sync polling)"
        echo "  Last modified: $(cmd_modified)"
        echo ""

        ok "Demo complete! Open Apple Notes to see the '${NOTE_NAME}' note."
        echo ""
        echo "Usage:"
        echo "  $0 list              - List all notes"
        echo "  $0 create            - Create the '${NOTE_NAME}' note"
        echo "  $0 read              - Read checklist items"
        echo "  $0 raw               - Raw HTML body"
        echo "  $0 add \"item\"        - Add checklist item"
        echo "  $0 toggle \"substr\"   - Toggle item by substring"
        echo "  $0 modified          - Get modification timestamp"
        echo "  $0 json              - Export as JSON"
        echo "  $0 demo              - Run this demo"
        ;;
    *)
        echo "Unknown command: $1"
        echo "Commands: list, create, read, raw, add, toggle, modified, json, demo"
        exit 1
        ;;
esac
