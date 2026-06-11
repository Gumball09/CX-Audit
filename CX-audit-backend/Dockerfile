# ---- build stage ----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage --------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# ffmpeg/ffprobe power the long-recording chunking fallback (src/lib/audio.ts).
RUN apk add --no-cache ffmpeg
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run as non-root.
USER node

# Default command is the API. Override for workers, e.g.:
#   docker run <img> node dist/workers/transcribe.worker.js
#   docker run <img> node dist/workers/audit.worker.js
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/index.js"]
