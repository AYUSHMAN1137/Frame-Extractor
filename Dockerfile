FROM node:20-bullseye

RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip \
  && pip3 install --no-cache-dir yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["npm", "start"]
