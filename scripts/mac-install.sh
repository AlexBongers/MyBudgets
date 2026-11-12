#!/usr/bin/env bash
# Synchroniseert MyBudgets naar een lokale map op je Mac, bouwt de app en installeert hem in /Applications.
#   curl -fsSL https://raw.githubusercontent.com/AlexBongers/MyBudgets/ccr-5dfeb8b3-1ppgpa/scripts/mac-install.sh | bash
# of, vanuit een bestaande clone:  bash scripts/mac-install.sh
# Variabelen: DIR (standaard ~/MyBudgets), BRANCH (standaard ccr-5dfeb8b3-1ppgpa)
set -euo pipefail
DIR="${DIR:-$HOME/MyBudgets}"; BRANCH="${BRANCH:-ccr-5dfeb8b3-1ppgpa}"
REPO="https://github.com/AlexBongers/MyBudgets.git"

command -v git >/dev/null  || { echo "git ontbreekt: installeer de Xcode Command Line Tools (xcode-select --install)"; exit 1; }
command -v node >/dev/null || { echo "Node.js ontbreekt: installeer Node 22+ (https://nodejs.org of 'brew install node')"; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "Node 22 of nieuwer is nodig (jij hebt $(node -v))"; exit 1; }

if [ -d "$DIR/.git" ]; then
  echo "→ Synchroniseren in $DIR"; git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout "$BRANCH" && git -C "$DIR" pull --ff-only origin "$BRANCH"
else
  echo "→ Clonen naar $DIR"; git clone --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"
echo "→ Dependencies installeren"; npm ci
echo "→ Tests"; npm test
echo "→ App bouwen (.dmg)"; npm run dist

APP="$(ls -d dist/mac*/MyBudgets.app 2>/dev/null | head -1 || true)"
if [ -n "$APP" ]; then
  echo "→ Installeren in /Applications"
  rm -rf "/Applications/MyBudgets.app"; cp -R "$APP" /Applications/
  xattr -cr /Applications/MyBudgets.app 2>/dev/null || true   # niet ondertekend: quarantaine weghalen
  echo "Klaar: /Applications/MyBudgets.app is geïnstalleerd."
fi
echo "De .dmg staat in $DIR/dist/"; ls -1 dist/*.dmg 2>/dev/null || true
