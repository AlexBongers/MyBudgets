#!/usr/bin/env bash
# Installeert MyBudgets als server op een Debian/Ubuntu-LXC of -VM (als root). Gebruik:
#   git clone https://github.com/AlexBongers/MyBudgets && cd MyBudgets && bash scripts/install-server.sh
set -euo pipefail
cd "$(dirname "$0")/.."

IN_LXC=0
if [ -f /run/systemd/container ] && [ "$(cat /run/systemd/container)" = lxc ]; then IN_LXC=1; fi

nesting_hint() {
  cat <<'MSG'

Fout: de container kan niet starten. In een LXC moet 'nesting' aan staan, anders
weigert de kernel/runc het proc-mount in de container. Zet dat op de Proxmox-host
aan en herstart de container:

  pct set <vmid> --features nesting=1,keyctl=1
  pct reboot <vmid>

(<vmid> vind je op de host met 'pct list'.) Daarna dit script opnieuw draaien.
MSG
}

if [ "$IN_LXC" = 1 ]; then
  echo "LXC gedetecteerd; nesting wordt bij de containerstart gecontroleerd."
fi

if ! command -v docker >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq docker.io
  # Compose: plugin-pakket waar dat bestaat (Debian 13/Ubuntu), anders de klassieke v1 (Debian 12).
  apt-get install -y -qq docker-compose-v2 2>/dev/null \
    || apt-get install -y -qq docker-compose-plugin 2>/dev/null \
    || apt-get install -y -qq docker-compose
fi
systemctl enable --now docker >/dev/null 2>&1 || true

if ! docker info >/dev/null 2>&1; then
  echo
  echo "Docker start niet."
  if [ "$IN_LXC" = 1 ]; then nesting_hint; fi
  systemctl status docker --no-pager 2>&1 | head -15 || true
  exit 1
fi

COMPOSE=""
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"          # plugin (nieuw)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"          # v1 (Debian 12)
else
  echo "Fout: geen compose-runtime gevonden (docker compose of docker-compose)."
  exit 1
fi

if [ ! -f .env ]; then
  PW=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
  echo "MYBUDGETS_PASSWORD=$PW" > .env; chmod 600 .env
  echo "Wachtwoord aangemaakt (staat in $(pwd)/.env): $PW"
else
  echo "Bestaand .env gevonden; het wachtwoord daaruit wordt gebruikt ($(pwd)/.env)."
fi

mkdir -p data && chown 1000:1000 data
$COMPOSE up -d --build || true   # fouten hier worden onderaan afgevangen, zodat de hint altijd komt

# Controleer dat de container echt loopt; in een LXC zonder nesting faalt dit op het proc-mount.
if ! docker ps --filter name=mybudgets --filter status=running -q | grep -q .; then
  echo
  echo "De container is niet gestart."
  if [ "$IN_LXC" = 1 ]; then nesting_hint; fi
  $COMPOSE logs --tail=15 2>&1 || true
  exit 1
fi

echo; echo "Klaar. Open in je browser: http://$(hostname -I | awk '{print $1}'):3000  (gebruikersnaam: leeg of iets, wachtwoord: zie $(pwd)/.env)"
echo "Eigen gegevens meenemen: $COMPOSE down, zet je back-up als data/budget.db (chown 1000:1000), $COMPOSE up -d"
