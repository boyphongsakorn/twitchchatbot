FROM node:20
# RUN apk add --no-cache font-noto-thai libevent libevent-dev chromium
# RUN apk add --no-cache font-noto-thai && apk add --no-cache libevent libevent-dev chromium

# RUN apk add --no-cache \
#       chromium \
#       nss \
#       freetype \
#       harfbuzz \
#       ca-certificates \
#       ttf-freefont 
      
# ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR '/app'

# COPY ./Mitr-Regular.ttf ./
# COPY ./NumberByHand-Regular.ttf ./
# RUN mkdir -p /usr/share/fonts/truetype/
# RUN install -m644 Mitr-Regular.ttf /usr/share/fonts/truetype/
# RUN install -m644 NumberByHand-Regular.ttf /usr/share/fonts/truetype/
# RUN rm ./Mitr-Regular.ttf
# RUN rm ./NumberByHand-Regular.ttf

# RUN npm install -g pnpm
# COPY package*.json ./
# COPY pnpm-*.yaml ./
# RUN pnpm fetch --prod
ADD . ./

RUN npm install
CMD ["npm","start","dev"]
