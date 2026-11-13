FROM debian:bookworm-slim AS whisper-build
ARG WHISPER_REV=2eeeba56e9edd762b4b38467bab96c2517163158
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl cmake g++ make && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSL --retry 3 "https://github.com/ggml-org/whisper.cpp/archive/${WHISPER_REV}.tar.gz" | tar -xz --strip-components=1 \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF \
    && cmake --build build --config Release --target whisper-cli -j2

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg fonts-noto-cjk libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=whisper-build /build/build/bin/whisper-cli /usr/local/bin/whisper-cli
RUN mkdir -p /opt/whisper \
    && curl -fsSL --retry 3 https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -o /opt/whisper/ggml-base.bin \
    && echo '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe  /opt/whisper/ggml-base.bin' | sha256sum -c -
WORKDIR /app
COPY --chown=node:node public ./public
COPY --chown=node:node server ./server
COPY --chown=node:node package.json shared-backend.json ./
RUN mkdir -p /app/.local && chown node:node /app/.local
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 STILL_BACKEND=supabase \
    WHISPER_PATH=/usr/local/bin/whisper-cli WHISPER_MODEL=/opt/whisper/ggml-base.bin \
    MEDIA_KOREAN_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/start.mjs"]
