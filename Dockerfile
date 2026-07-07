FROM node:20-alpine

WORKDIR /app

# Enable Corepack for Yarn 4
RUN corepack enable

# Copy dependency configuration
COPY package.json yarn.lock .pnp.cjs .pnp.loader.mjs ./
COPY .yarn/ ./.yarn/

# Production-only dependency install
RUN yarn install --immutable

# Copy source code and specs
COPY src/ ./src/

# Secure execution as non-root user
RUN addgroup -S demi && adduser -S demi -G demi
USER demi

# Expose Express server port
EXPOSE 5001

# Default CMD (Express API)
CMD ["node", "src/server.js"]
