FROM node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3 native addon
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --production

COPY server.js ./
COPY data/ ./data/

EXPOSE 3100

ENV NODE_ENV=production
CMD ["node", "server.js"]
