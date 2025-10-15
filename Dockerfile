# brandora-verify/Dockerfile
FROM node:20-alpine
WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci || npm install

# Copy source
COPY . .

# Expose whatever PORT we set (default 3002 for local)
EXPOSE 3002
# Run the local wrapper server (devServer.js)
CMD ["npm", "run", "serve"]

