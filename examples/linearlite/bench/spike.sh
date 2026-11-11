#!/bin/zsh
# usage: spike.sh <n> <reps>: seeds a "list" and an "all" profile, then alternates cold opens, each in a fresh Chrome
n=$1 reps=$2
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
typeset -A PROFILE
PROFILE[list]=$(mktemp -d); PROFILE[all]=$(mktemp -d)
go() { # shape seed
  "$CHROME" --headless=new --disable-gpu --user-data-dir=${PROFILE[$1]} --remote-debugging-port=9333 about:blank >/dev/null 2>&1 &
  local pid=$!
  sleep 1.5
  agent-browser connect 9333 >/dev/null 2>&1 || { echo "connect failed"; kill $pid; return; }
  agent-browser open "http://127.0.0.1:4180/spike?n=$n&shape=$1&run=x&seed=$2" >/dev/null 2>&1
  agent-browser wait "#spike" >/dev/null 2>&1 || agent-browser wait 30000 >/dev/null 2>&1
  agent-browser get text "#spike" 2>&1
  agent-browser close >/dev/null 2>&1
  kill $pid 2>/dev/null; wait $pid 2>/dev/null; sleep 1
}
echo "seed list: $(go list 1)"; echo "seed all:  $(go all 1)"
for i in $(seq $reps); do
  if (( i % 2 )); then a=list b=all; else a=all b=list; fi
  echo "cold $a: $(go $a 0)"; echo "cold $b: $(go $b 0)"
done
rm -rf ${PROFILE[list]} ${PROFILE[all]}
