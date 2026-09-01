#!/bin/sh
# Prints the README terminal transcript. Regenerate the screenshot with:
#   freeze --execute "sh assets/gh-pr-checks.sh" --window --theme github \
#     --font.family "Menlo" --font.size 16 --width 1600 \
#     --margin 60 --shadow.blur 24 --shadow.y 16 \
#     --output assets/gh-pr-checks.png
# Text after "##[error]" mirrors test/fixtures/messages/unresolved-threads-needs-review.txt.
GREY=$(printf '\033[90m')
RED=$(printf '\033[1;31m')
GREEN=$(printf '\033[1;32m')
RESET=$(printf '\033[0m')

cat <<EOF
\$ gh pr checks 6
Some checks were not successful
0 cancelled, 1 failing, 1 successful, 0 skipped, and 0 pending checks

    NAME                                            DESCRIPTION  ELAPSED  URL
${RED}X${RESET}   Codex Review Check/Codex Review (pull_request)              1m13s    https://github.com/kkkiio/pi-workmap/actio…
${GREEN}✓${RESET}  CI/check (pull_request)                                      44s      https://github.com/kkkiio/pi-workmap/actio…

\$ gh run view 33499862152 --log-failed 2>&1 | tail -4
${GREY}Codex Review  Check Codex review state${RESET}  Blocking Codex review thread: https://github.com/kkkiio/pi-workmap/pull/6#discussion_r2211845578
${GREY}Codex Review  Check Codex review state${RESET}  ${RED}##[error]${RESET}2 unresolved Codex review thread(s) are blocking (listed above). The current HEAD has no
Codex review yet. Next steps: 1) resolve each handled conversation 2) gh pr comment 6 --body '@codex review' 3) gh run rerun 33499862152 --failed.
If you already resolved the threads after this run started, start at step 2.
\$
EOF
