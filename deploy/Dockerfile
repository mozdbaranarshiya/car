FROM node:24-bookworm-slim
WORKDIR /app
COPY server/ ./server/
COPY supabase/functions/_shared/ ./supabase/functions/_shared/
RUN node server/scripts/fetch-vendor.mjs && mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server/src.mjs"]
