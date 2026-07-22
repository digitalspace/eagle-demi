# Central Express API & Worker runtime image
FROM node:24-alpine
WORKDIR /app

# Enable Corepack for Yarn 4
RUN corepack enable

# Copy backend dependency configuration
COPY package.json yarn.lock ./
COPY .yarn/ ./.yarn/

# Production-only backend dependency install
RUN yarn install --immutable

# Copy backend source code and ensure static public directory exists
COPY src/ ./src/
RUN mkdir -p ./public

# Secure execution as non-root user
RUN addgroup -S demi && adduser -S demi -G demi
USER demi

# Expose Express server port
EXPOSE 3000

# Default CMD (Express API)
CMD ["node", "src/server.js"]
