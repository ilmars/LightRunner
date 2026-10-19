#!/bin/sh
# Re-import the Dieva Mājas L1 rig from Lightkey with the agreed groups.
# Usage: tools/import-dieva-majas.sh [path/to/project.lightkeyproj]
set -e
cd "$(dirname "$0")/.."
PROJECT="${1:-$HOME/Documents/Dieva Majas Skatuve - L1.lightkeyproj}"
python3 -I tools/import-lightkey.py "$PROJECT" shows/dieva-majas-l1.json \
  --artnet-host 192.168.0.114 --universe 1 \
  --skip p5 \
  --group "Front lights=p1,p2,p3,p4" \
  --group "Key lights=b1,b2" \
  --group "Background=b3,b4,b5,b6" \
  --group "Drum cage=l1" \
  --group "B8 side bar=b8"
