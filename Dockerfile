FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

RUN npm i -D typescript ts-node @types/node @types/bn.js && npx tsc -p .

CMD ["node", "dist/index.js"]

