FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y ffmpeg curl ca-certificates \
  && curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["npm", "start"]
