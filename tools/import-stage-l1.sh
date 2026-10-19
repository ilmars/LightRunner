#!/bin/sh
# Re-import the stage L1 rig from Lightkey with the agreed groups.
# Usage: tools/import-stage-l1.sh path/to/project.lightkeyproj
set -e
cd "$(dirname "$0")/.."
PROJECT="${1:-$LIGHTKEY_PROJECT}"
if [ -z "$PROJECT" ]; then
  echo "Usage: tools/import-stage-l1.sh path/to/project.lightkeyproj (or set LIGHTKEY_PROJECT)" >&2
  exit 2
fi
python3 -I tools/import-lightkey.py "$PROJECT" shows/stage-l1.json \
  --name "Stage L1 (from Lightkey)" \
  --artnet-host 192.168.0.114 --universe 1 \
  --skip p5 \
  --group "Front lights=p1,p2,p3,p4" \
  --group "Key lights=b1,b2" \
  --group "Background=b3,b4,b5,b6" \
  --group "Drum cage=l1" \
  --group "B8 side bar=b8"
