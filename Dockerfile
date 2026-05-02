FROM node:20-alpine AS build
WORKDIR /app

RUN apk add --no-cache python3 make g++ \
    && ln -sf python3 /usr/bin/python

COPY package.json package-lock.json* npm-shrinkwrap.json* yarn.lock* ./
RUN if [ -f package-lock.json ]; then npm ci; \
    else npm install; \
    fi

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build:docker

RUN npm prune --omit=dev


FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NODE_OPTIONS="--enable-source-maps"

RUN mkdir -p /app/data && chown node:node /app/data

USER node

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./

CMD ["node", "dist/index.js"]
