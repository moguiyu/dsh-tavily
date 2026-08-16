set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DSH_LOCAL_CLIENT:-$HOME/.dsh/profiles/node_modules/dsh-tool-tavily-search/lib/client.js}"

if [ ! -f "$DEST" ]; then
  echo "Local client bundle not found at: $DEST" >&2
  echo "Set DSH_LOCAL_CLIENT to the correct path if your plugin is installed elsewhere." >&2
  exit 1
fi

cp "$ROOT/packages/dsh-tool-tavily-search/lib/client.js" "$DEST"
perl -pi -e 's/id: "\@moguiyu\/dsh-tool-tavily-search"/id: "dsh-tool-tavily-search"/' "$DEST"

echo "Updated local plugin client bundle:"
echo "  $DEST"
