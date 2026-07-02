# syntax=docker/dockerfile:1

FROM node:22-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

RUN apk add --no-cache dumb-init su-exec \
    && addgroup -g 1001 -S csss \
    && adduser -S csss -u 1001 -G csss \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY . .

RUN sed -i 's/\r$//' /app/docker/entrypoint.sh \
    && chmod +x /app/docker/entrypoint.sh

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:10000/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "/app/docker/entrypoint.sh"]
CMD ["node", "src/app.js"]
