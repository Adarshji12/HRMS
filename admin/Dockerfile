# MyDeskTime console: build the static bundle, serve it from nginx.

FROM node:20-alpine AS build
WORKDIR /build
# Copy manifests first so a source-only change does not reinstall the world.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The console calls /api/v1 on its own origin and nginx proxies it onward, so
# there is no API URL to bake in — one image works in every environment.
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /build/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
