#!/usr/bin/env bash
# Installeert MyBudgets als server op een Debian/Ubuntu-LXC of -VM (als root). Gebruik:
#   git clone https://github.com/AlexBongers/MyBudgets && cd MyBudgets && bash scripts/install-server.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v docker >/dev/null; then apt-get update -qq && apt-get install -y -qq docker.io docker-compose-v2 2>/dev/null || apt-get install -y -qq docker.io docker-compose; fi
systemctl enable --now docker >/dev/null 2>&1 || true
if [ ! -f .env ]; then
  PW=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
  echo "MYBUDGETS_PASSWORD=$PW" > .env; chmod 600 .env
  echo "Wachtwoord aangemaakt (staat in $(pwd)/.env): $PW"
fi
mkdir -p data && chown 1000:1000 data
if docker compose version >/dev/null 2>&1; then docker compose up -d --build; else docker-compose up -d --build; fi
echo; echo "Klaar. Open in je browser: http://$(hostname -I | awk '{print $1}'):3000  (gebruikersnaam: leeg of iets, wachtwoord: zie boven)"
echo "Eigen gegevens meenemen: docker compose down, zet je back-up als data/budget.db (chown 1000:1000), docker compose up -d"
