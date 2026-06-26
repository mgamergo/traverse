FROM oven/bun:1

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
RUN bunx playwright install --with-deps chromium

COPY . .

EXPOSE 8080

CMD ["bun", "apps/server/index.ts"]
