FROM node:24.14.0-bookworm-slim
WORKDIR /app/live-data
COPY live-data/package.json live-data/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY live-data/src ./src
COPY live-data/runtime ./runtime
COPY live-data/migrations ./migrations
COPY live-data/scripts/build-assets.mjs ./scripts/build-assets.mjs
COPY observatories /app/observatories
COPY css/editorial.css css/observatory.css /app/css/
COPY js/observatory.js js/observatory-map.js /app/js/
COPY assets/vendor/d3.v7.min.js /app/assets/vendor/d3.v7.min.js
COPY assets/vendor/leaflet /app/assets/vendor/leaflet
RUN npm run build
ENV PORT=8080 DB_PATH=/data/lab.sqlite
EXPOSE 8080
CMD ["node", "runtime/server.mjs"]
