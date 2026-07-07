# Builds the enclave image. Pin the resulting digest in tinfoil-config.yml.
# Keep deps minimal — this image is measured and published; smaller TCB = easier audit.
FROM node:20-slim
# openssh-server provides sshd (the supervisor hosts SSH; sandbox images need none);
# openssh-client provides ssh-keygen for the boot host key + in-enclave keypair minting;
# openssl mints the in-enclave TLS-bridge key + self-signed cert at boot (initTlsBridge).
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server openssh-client openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY supervisor.js ./
# enclave-vault: the wallet-gated volume protocol the supervisor imports (unseal
# delivered VEKs + seal auto-grants); single source of truth with the client.
COPY scripts/enclave-vault.mjs ./scripts/enclave-vault.mjs
# dedicated-IP egress: the enclave-side SOCKS front + its SSRF classifier
# (net-guard.mjs is also symlinked into relay/ and shipped to the relay box).
COPY egress.js ./
COPY addressbook.js ./
COPY net-guard.mjs ./
# If you add the spawn implementation in its own files, COPY them here too.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "supervisor.js"]
