# D2D Phase-1 service — single image for Render (Docker runtime).
# Stage 1: build TypeScript. Stage 2: lean runtime with prod deps only.

FROM node:22-alpine AS build
WORKDIR /app/service
COPY service/package*.json ./
RUN npm ci
COPY service/tsconfig.json ./
COPY service/src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/service
COPY service/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/service/dist ./dist
# The editable frameworks ship with the image; D2D_CONFIG_DIR can point elsewhere later.
COPY d2d /app/d2d
EXPOSE 8000
CMD ["node", "dist/server.js"]
