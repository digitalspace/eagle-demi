# Stage 1: Build the Angular frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# Enable Corepack for Yarn
RUN corepack enable

# Copy frontend dependency configuration
COPY frontend/package.json frontend/yarn.lock ./
COPY frontend/.yarn/ ./.yarn/

# Install frontend dependencies
RUN yarn install --immutable

# Copy frontend source code and configs
COPY frontend/src/ ./src/
COPY frontend/public/ ./public/
COPY frontend/angular.json frontend/tsconfig*.json ./

# Build frontend (outputs to /app/public)
RUN yarn build

# Stage 2: Create the central Express API runtime image
FROM node:20-alpine
WORKDIR /app

# Enable Corepack for Yarn 4
RUN corepack enable

# Copy backend dependency configuration
COPY package.json yarn.lock ./
COPY .yarn/ ./.yarn/

# Production-only backend dependency install
RUN yarn install --immutable

# Copy backend source code
COPY src/ ./src/

# Copy the compiled frontend static files from Stage 1 builder
COPY --from=frontend-builder /app/public/ ./public/

# Secure execution as non-root user
RUN addgroup -S demi && adduser -S demi -G demi
USER demi

# Expose Express server port
EXPOSE 5001

# Default CMD (Express API)
CMD ["node", "src/server.js"]
