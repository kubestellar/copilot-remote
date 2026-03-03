#!/usr/bin/env bash
# CDP automated test: terminal tile rendering in copilot-remote web UI
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0
TOTAL=6
MSG_ID=1

# --- Setup WebSocket URL ---
echo -e "${BOLD}Setting up CDP connection...${NC}"
WS_URL=$(curl -s http://127.0.0.1:9222/json/list | jq -r '.[] | select(.url | test("localhost:(5173|8080)")) | .webSocketDebuggerUrl' | head -1)
if [[ -z "$WS_URL" || "$WS_URL" == "null" ]]; then
  echo -e "${RED}ERROR: Could not find copilot-remote page on CDP. Is Chrome running with --remote-debugging-port=9222?${NC}"
  exit 1
fi
echo "WebSocket URL: $WS_URL"

# --- Helper functions ---

cdp_eval() {
  local js="$1"
  local escaped
  escaped=$(printf '%s' "$js" | jq -Rsa .)
  local payload="{\"id\":${MSG_ID},\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":${escaped},\"returnByValue\":true}}"
  MSG_ID=$((MSG_ID + 1))
  echo "$payload" | websocat -n1 -B 1000000 "$WS_URL" | jq -r '.result.result.value // empty'
}

cdp_screenshot() {
  local filename="$1"
  local payload="{\"id\":${MSG_ID},\"method\":\"Page.captureScreenshot\",\"params\":{\"format\":\"jpeg\",\"quality\":70}}"
  MSG_ID=$((MSG_ID + 1))
  echo "$payload" | websocat -n1 -B 10000000 "$WS_URL" | jq -r '.result.data' | base64 -d > "$filename"
  echo -e "  ${YELLOW}Screenshot saved: ${filename}${NC}"
}

cdp_reload() {
  local payload="{\"id\":${MSG_ID},\"method\":\"Page.reload\",\"params\":{}}"
  MSG_ID=$((MSG_ID + 1))
  echo "$payload" | websocat -n1 "$WS_URL" > /dev/null 2>&1 || true
  # Re-acquire WS URL after reload (may change)
  sleep 2
  WS_URL=$(curl -s http://127.0.0.1:9222/json/list | jq -r '.[] | select(.url | test("localhost:(5173|8080)")) | .webSocketDebuggerUrl' | head -1)
}

check_tile_content() {
  # Returns comma-separated non-empty row counts for each visible xterm element
  local js
  js='(function() {
    var xtermEls = document.querySelectorAll(".xterm");
    var results = [];
    for (var i = 0; i < xtermEls.length; i++) {
      var el = xtermEls[i];
      if (getComputedStyle(el).visibility === "hidden" || getComputedStyle(el).display === "none") continue;
      if (el.offsetWidth < 10 || el.offsetHeight < 10) continue;
      var rows = el.querySelector(".xterm-rows");
      if (!rows) continue;
      var nonEmpty = 0;
      for (var j = 0; j < rows.children.length; j++) {
        if (rows.children[j].textContent.trim()) nonEmpty++;
      }
      results.push(nonEmpty);
    }
    return results.join(",");
  })()'
  cdp_eval "$js"
}

# Verify that at least $expected_count tiles each have > 5 non-empty rows
verify_tiles() {
  local expected_count="$1"
  local csv
  csv=$(check_tile_content)
  echo -e "  Tile row counts: [${csv}]"

  if [[ -z "$csv" ]]; then
    echo -e "  ${RED}No visible xterm elements found${NC}"
    return 1
  fi

  IFS=',' read -ra counts <<< "$csv"
  local good=0
  for c in "${counts[@]}"; do
    if [[ "$c" -gt 5 ]]; then
      good=$((good + 1))
    fi
  done

  if [[ "$good" -ge "$expected_count" ]]; then
    echo -e "  ${GREEN}Found $good tile(s) with content (expected >= $expected_count)${NC}"
    return 0
  else
    echo -e "  ${RED}Only $good tile(s) with content (expected >= $expected_count)${NC}"
    return 1
  fi
}

click_checkbox() {
  local idx="$1"
  cdp_eval "document.querySelectorAll('input[type=checkbox]')[${idx}].click(); 'done'" > /dev/null
}

report() {
  local step="$1"
  local desc="$2"
  local result="$3"
  if [[ "$result" == "0" ]]; then
    echo -e "${GREEN}PASS${NC} — Step ${step}: ${desc}"
    PASSED=$((PASSED + 1))
  else
    echo -e "${RED}FAIL${NC} — Step ${step}: ${desc}"
    FAILED=$((FAILED + 1))
  fi
}

# --- Reset all checkboxes to unchecked ---
echo -e "\n${BOLD}Resetting checkboxes...${NC}"
cdp_eval 'document.querySelectorAll("input[type=checkbox]").forEach(function(cb){ if(cb.checked) cb.click() }); "reset done"'
sleep 3

# ===================== TEST STEPS =====================

# Step 1: Baseline — single terminal has content
echo -e "\n${BOLD}Step 1: Baseline (single terminal)${NC}"
cdp_screenshot "/tmp/tile_cdp_test_1_baseline.jpg"
rc=0; verify_tiles 1 || rc=1
report 1 "Baseline — at least 1 terminal has content" "$rc"

# Step 2: Check 2 tiles — click checkbox 0 and 1
echo -e "\n${BOLD}Step 2: Enable 2 tiles${NC}"
click_checkbox 0
click_checkbox 1
sleep 3
cdp_screenshot "/tmp/tile_cdp_test_2_two_tiles.jpg"
rc=0; verify_tiles 2 || rc=1
report 2 "2 tiles — both have content" "$rc"

# Step 3: Check all 4 tiles — click checkbox 2 and 3
echo -e "\n${BOLD}Step 3: Enable all 4 tiles${NC}"
click_checkbox 2
click_checkbox 3
sleep 3
cdp_screenshot "/tmp/tile_cdp_test_3_four_tiles.jpg"
rc=0; verify_tiles 4 || rc=1
report 3 "4 tiles — all have content" "$rc"

# Step 4: Uncheck to 2 tiles — uncheck checkbox 2 and 3
echo -e "\n${BOLD}Step 4: Back to 2 tiles${NC}"
click_checkbox 2
click_checkbox 3
sleep 3
cdp_screenshot "/tmp/tile_cdp_test_4_back_two.jpg"
rc=0; verify_tiles 2 || rc=1
report 4 "Uncheck to 2 tiles — both remaining have content" "$rc"

# Step 5: Uncheck all — uncheck checkbox 0 and 1
echo -e "\n${BOLD}Step 5: Uncheck all (single terminal)${NC}"
click_checkbox 0
click_checkbox 1
sleep 3
cdp_screenshot "/tmp/tile_cdp_test_5_single.jpg"
rc=0; verify_tiles 1 || rc=1
report 5 "Uncheck all — single terminal has content" "$rc"

# Step 6: Reload page
echo -e "\n${BOLD}Step 6: Reload page${NC}"
cdp_reload
sleep 6
cdp_screenshot "/tmp/tile_cdp_test_6_reload.jpg"
rc=0; verify_tiles 1 || rc=1
report 6 "Reload — terminal has content after reload" "$rc"

# ===================== SUMMARY =====================
echo ""
echo -e "${BOLD}=============================${NC}"
if [[ "$FAILED" -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}${PASSED}/${TOTAL} tests passed ✓${NC}"
else
  echo -e "${YELLOW}${BOLD}${PASSED}/${TOTAL} tests passed${NC} (${RED}${FAILED} failed${NC})"
fi
echo -e "${BOLD}=============================${NC}"

[[ "$FAILED" -eq 0 ]] && exit 0 || exit 1
