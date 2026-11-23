# Use official lightweight Node.js Alpine base image
FROM node:20-alpine

# Set working directory inside container
WORKDIR /usr/src/app

# Copy package manifests first for efficient Docker layer caching
COPY package*.json ./

# Install production and application dependencies
RUN npm ci --only=production

# Copy application source code and configuration files
COPY . .

# Expose API application port
EXPOSE 3000

# Set production environment by default inside the container
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]
