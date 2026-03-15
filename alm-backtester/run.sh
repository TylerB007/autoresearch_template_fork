#!/bin/bash
# Run a single backtest experiment with a 60-second timeout
timeout 60 npx tsx backtest.ts > run.log 2>&1
exit_code=$?
if [ $exit_code -ne 0 ]; then
  echo "CRASH: exit code $exit_code" >> run.log
fi
