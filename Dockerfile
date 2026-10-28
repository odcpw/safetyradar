# Safety Radar – pipeline + build image. Output: /app/dist (serve with Caddy/nginx on the host).
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils git ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
ENV TZ=Europe/Zurich NOINDEX=1 SITE=https://safetyradar.ch BASE=/
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# Default: run the daily pipeline (fetch + LLM if OPENAI_API_KEY set + build). Mount ./data and ./dist as volumes.
CMD ["npm", "run", "update"]
