FROM node:22-alpine

WORKDIR /app

# Копируем зависимости
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем исходный код
COPY . .

# Собираем клиентскую часть (Vite)
RUN npm run build

# Порт для сервиса
EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

# Запуск сервера бота
CMD ["npm", "start"]
