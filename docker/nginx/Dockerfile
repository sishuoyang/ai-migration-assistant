FROM nginx:alpine
RUN apk add --no-cache openssl && \
    mkdir -p /etc/nginx/ssl && \
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout /etc/nginx/ssl/self.key \
      -out /etc/nginx/ssl/self.crt \
      -subj "/CN=playground"
COPY nginx.conf /etc/nginx/conf.d/default.conf
