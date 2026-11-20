#!/usr/bin/env bash
# Publish docs/promo/wechat-article.md to the WeChat Official Account drafts folder.
#
# Provide WECHAT_APP_ID / WECHAT_APP_SECRET as environment variables, or
# store them in $HOME/.baoyu-skills/.env (or a file set by WECHAT_ENV_FILE).
# Prerequisite: add this machine's public IP to the account's IP allowlist.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${WECHAT_ENV_FILE:-$HOME/.baoyu-skills/.env}"
EXTRA=()
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  EXTRA+=(--env-file "$ENV_FILE")
fi

if [ -z "$WECHAT_APP_ID" ] || [ -z "$WECHAT_APP_SECRET" ]; then
  echo "Missing credentials: set WECHAT_APP_ID / WECHAT_APP_SECRET or add them to $ENV_FILE" >&2
  exit 1
fi

wenyan publish \
  "${EXTRA[@]}" \
  -f docs/promo/wechat-article.md \
  -t lapis -h solarized-light --no-footnote

echo "Published to drafts. Sign in at https://mp.weixin.qq.com → Content Management → Drafts to review and publish."
