FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV PORT=3000
# CACHE_DIR points here by default so a Docker volume can persist it.
# It holds two separate files: tmdb-cache.json and omdb-cache.json.
ENV CACHE_DIR=/app/data

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server.js"]
