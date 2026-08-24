# The snapshot ships COMPRESSED: 194 MB → 68 MB of build context. That upload,
# from a home connection to a remote depot builder, is the single fragile step in
# this deploy — it stalled mid-transfer on 8/24/26 ("read: operation timed out"
# partway through "load build context") and cost that week's refresh. Decompressed
# in a throwaway stage so the final image still carries only the plain .db, with
# no .gz layer left behind: the image stays the size it was, the upload is a third.
FROM node:20-slim AS snapshot
WORKDIR /snapshot
COPY data/ct-upm.db.gz .
RUN gunzip ct-upm.db.gz

FROM node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3 native addon
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --production

COPY server.js ./

# Last, and from the throwaway stage: everything above stays cached when only the
# weekly snapshot changes. Path must match server.js DB_PATH (data/ct-upm.db).
COPY --from=snapshot /snapshot/ct-upm.db ./data/ct-upm.db

EXPOSE 3100

ENV NODE_ENV=production
CMD ["node", "server.js"]
