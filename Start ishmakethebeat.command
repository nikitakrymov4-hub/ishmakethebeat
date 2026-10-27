#!/bin/sh
cd "$(dirname "$0")" || exit 1
./start.sh --open
ISH_STATUS=$?
if [ "$ISH_STATUS" -ne 0 ]; then
  printf '\nThe studio could not start. Check the message above.\nPress Return to close this window.'
  read -r ISH_CLOSE
fi
exit "$ISH_STATUS"
