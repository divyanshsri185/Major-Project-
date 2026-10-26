FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/invigil.db
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
