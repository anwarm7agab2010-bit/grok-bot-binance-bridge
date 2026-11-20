FROM node:20-alpine
WORKDIR /app
COPY package.json binance-bridge.js ./
ENV PORT=8000
EXPOSE 8000
CMD ["node", "binance-bridge.js"]
