#!/usr/bin/env bash

# ==============================================================================
# Script: test_rate_limit.sh
# Description: Automated test script for Rate Limit Engine (Sliding Window Log)
# ==============================================================================
# 
# Purpose:
#   Sends 10 consecutive HTTP GET requests to the rate-limited endpoint:
#   http://localhost:3000/api/test
# 
#   For each request, the script captures:
#     - The HTTP status code (200, 429, or unexpected)
#     - The JSON response body
#     - The evaluation status (REQUEST ALLOWED, REQUEST BLOCKED, UNEXPECTED RESPONSE)
# 
# Usage:
#   bash test_rate_limit.sh
# 
# Prerequisites:
#   Ensure the backend server is running on port 3000 before running this script:
#     npm start  (or npm run dev / docker-compose up)
# ==============================================================================

# Target API endpoint (can be overridden via TARGET_URL environment variable)
TARGET_URL="${TARGET_URL:-http://localhost:3000/api/test}"
TOTAL_REQUESTS=10

# ANSI color codes for readable terminal output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color (reset)

echo -e "${BOLD}${CYAN}======================================================================${NC}"
echo -e "${BOLD}${CYAN}       Starting Automated Rate Limiter Test (Sliding Window Log)       ${NC}"
echo -e "${BOLD}${CYAN}======================================================================${NC}"
echo -e "Target URL:       ${BOLD}${TARGET_URL}${NC}"
echo -e "Total Requests:   ${BOLD}${TOTAL_REQUESTS}${NC}"
echo -e "Configured Limit: ${BOLD}5 requests per 60 seconds${NC}"
echo -e "Expected Result:  ${BOLD}First 5 ALLOWED (200), subsequent BLOCKED (429)${NC}"
echo -e "${CYAN}----------------------------------------------------------------------${NC}\n"

# Counter variables to track results summary
allowed_count=0
blocked_count=0
unexpected_count=0

# Loop 10 times to send consecutive requests
for (( i=1; i<=TOTAL_REQUESTS; i++ ))
do
  echo -e "${BOLD}--- [Request #${i} of ${TOTAL_REQUESTS}] ---${NC}"

  # Execute HTTP GET request using curl:
  #   -s : Silent mode (suppresses curl's progress bar and meter)
  #   -w "\n%{http_code}" : Appends a newline followed by the HTTP status code
  #
  # This pattern allows us to capture the response body AND the status code
  # in a single network round-trip without creating temporary files on disk.
  response=$(curl -s -w "\n%{http_code}" "${TARGET_URL}")

  # Separate the status code (the last line) and the response body (everything before the last line)
  # In Bash parameter expansion:
  #   ${response##*$'\n'} extracts everything after the final newline (HTTP code)
  #   ${response%$'\n'*}  extracts everything before the final newline (Response body)
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"

  # Display the HTTP Status Code
  echo -e "HTTP Status Code: ${BOLD}${http_code}${NC}"

  # Display the Response Body (formatted nicely if empty or JSON)
  if [ -z "${body}" ]; then
    echo -e "Response Body:    ${YELLOW}(empty)${NC}"
  else
    echo -e "Response Body:    ${body}"
  fi

  # Evaluate the HTTP Status Code
  case "${http_code}" in
    200)
      echo -e "Result:           ${GREEN}${BOLD}✓ REQUEST ALLOWED (HTTP 200 OK)${NC}"
      ((allowed_count++))
      ;;
    429)
      echo -e "Result:           ${RED}${BOLD}✗ REQUEST BLOCKED (HTTP 429 Too Many Requests)${NC}"
      ((blocked_count++))
      ;;
    000)
      echo -e "Result:           ${YELLOW}${BOLD}! UNEXPECTED RESPONSE (Cannot connect to server)${NC}"
      echo -e "                  ${YELLOW}Please verify that the backend is running at ${TARGET_URL}${NC}"
      ((unexpected_count++))
      ;;
    *)
      echo -e "Result:           ${YELLOW}${BOLD}! UNEXPECTED RESPONSE (HTTP ${http_code})${NC}"
      ((unexpected_count++))
      ;;
  esac

  echo "" # Empty line separator for readability

  # Optional tiny delay of 100ms between requests to simulate rapid sequential traffic
  sleep 0.1
done

# Summary Report
echo -e "${BOLD}${CYAN}======================================================================${NC}"
echo -e "${BOLD}${CYAN}                         Test Execution Summary                       ${NC}"
echo -e "${BOLD}${CYAN}======================================================================${NC}"
echo -e "Total Requests Sent: ${BOLD}${TOTAL_REQUESTS}${NC}"
echo -e "Allowed (HTTP 200):  ${GREEN}${BOLD}${allowed_count}${NC}"
echo -e "Blocked (HTTP 429):  ${RED}${BOLD}${blocked_count}${NC}"
echo -e "Unexpected / Errors: ${YELLOW}${BOLD}${unexpected_count}${NC}"
echo -e "${CYAN}----------------------------------------------------------------------${NC}"

if [ "${allowed_count}" -eq 5 ] && [ "${blocked_count}" -eq 5 ]; then
  echo -e "${GREEN}${BOLD}SUCCESS: Rate limiter is working exactly as expected! (5 allowed, 5 blocked)${NC}"
elif [ "${unexpected_count}" -gt 0 ]; then
  echo -e "${YELLOW}${BOLD}WARNING: Some requests encountered unexpected errors. Check backend logs.${NC}"
else
  echo -e "${YELLOW}${BOLD}NOTICE: Rate limiter behavior differed from default 5/5 split.${NC}"
  echo -e "${YELLOW}This can occur if previous requests were made within the active 60s sliding window.${NC}"
fi
echo -e "${BOLD}${CYAN}======================================================================${NC}\n"
