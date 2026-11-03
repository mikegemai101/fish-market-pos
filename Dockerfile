FROM node:22-alpine
ARG APP_VERSION=1.0.9
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY scripts ./scripts
COPY public ./public
RUN sed -i "s/const APP_VERSION='[^']*';/const APP_VERSION='v${APP_VERSION}';/" /app/public/app.js \
    && mkdir -p /app/uploads \
    && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node","server.js"]
