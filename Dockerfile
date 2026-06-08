# Playwright base image ships Chromium + all required OS libs.
# Pin to a version compatible with the Playwright npm dep in package.json (^1.40).
FROM mcr.microsoft.com/playwright:v1.58.2-jammy AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev deps for the runtime image.
RUN npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.58.2-jammy
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

EXPOSE 8080
CMD ["node", "dist/http-server.js"]
