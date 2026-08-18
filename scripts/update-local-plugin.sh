set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DSH_LOCAL_CLIENT:-$HOME/.dsh/profiles/node_modules/dsh-tavily/lib/client.js}"

if [ ! -f "$DEST" ]; then
  echo "Local client bundle not found at: $DEST" >&2
  echo "Set DSH_LOCAL_CLIENT to the correct path if your plugin is installed elsewhere." >&2
  exit 1
fi

cp "$ROOT/packages/dsh-tavily/lib/client.js" "$DEST"
perl -pi -e 's/id: "\@moguiyu\/dsh-tavily"/id: "dsh-tavily"/' "$DEST"

echo "Updated local plugin client bundle:"
echo "  $DEST"

# Patch old local backend packages so they wait for the credentials service.
for file in \
  "$HOME/.dsh/profiles/node_modules/dsh-tavily-manager/src/index.js" \
  "$HOME/.dsh/profiles/node_modules/dsh-tavily-usage/src/index.js" \
  "$HOME/.dsh/profiles/node_modules/dsh-tavily-settings/src/index.js"
do
  if [ -f "$file" ]; then
    perl -pi -e "s/export const inject = \['webServer'\]/export const inject = ['webServer', 'credentials']/" "$file"
    echo "Patched credentials inject:"
    echo "  $file"
  fi
done
