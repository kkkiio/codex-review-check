#!/bin/sh
# Captures REAL gh output for the README screenshot. Requires a failed Codex Review
# run to exist; override PR/RUN to target another one. Regenerate with:
#   freeze --execute "sh assets/gh-pr-checks.sh" --window --theme github \
#     --font.family "Menlo" --font.size 16 --line-height 1.6 --padding 36 \
#     --width 1600 --margin 60 --shadow.blur 24 --shadow.y 16 \
#     --output assets/gh-pr-checks.png
# The committed png was captured from run 33507420978 on kkkiio/codex-review-check#1.
PR=${PR:-1}
RUN=${RUN:-33507420978}

echo "\$ gh pr checks $PR"
gh pr checks "$PR" 2>&1 | cat
echo
echo "\$ gh run view $RUN --log-failed 2>&1 | tail -3 | fold -s -w 140"
gh run view "$RUN" --log-failed 2>&1 | tail -3 | fold -s -w 140
echo '$'
