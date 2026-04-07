FROM node:20-slim

# Playwright Chromium system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    fonts-liberation fonts-noto-color-emoji \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install Playwright Chromium (browser binary only, no dev deps)
RUN npx playwright install chromium

COPY . .

# Data directory (SQLite, artifacts, reports)
RUN mkdir -p /app/var

ENV POLICY_BOT_RUNTIME=slack
ENV POLICY_BOT_DATA_DIR=/app/var
ENV POLICY_BOT_BROWSER_HEADLESS=true
ENV NODE_ENV=production

CMD ["npx", "tsx", "src/index.ts"]
