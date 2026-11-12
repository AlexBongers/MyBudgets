# MyBudgets als server (Proxmox/LXC/Docker). Geen npm-dependencies nodig: alleen Node 24 met ingebouwde SQLite.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY renderer ./renderer
COPY samples/rabobank-demo.csv ./samples/rabobank-demo.csv
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/data/budget.db NODE_ENV=production
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--no-warnings", "src/server.js"]
