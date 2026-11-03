FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node","server.js"]
