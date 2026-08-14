FROM node:20-alpine
WORKDIR /app
# ไม่มี dependency — ข้าม npm install ไปเลย (build เร็วสุด)
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
