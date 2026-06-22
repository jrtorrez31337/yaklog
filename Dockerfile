FROM node:20-alpine

# git: required by GET /api/v1/canonical/* which runs `git show` against
# bind-mounted bare-git repos under /srv/git.
# age: required by POST /api/v1/register/<id>/jon-ratify which encrypts the
# minted registrant token to the registrant's age X25519 pubkey per ADR-0025
# §1 + ferry-canon §2. age-keygen also useful for ops debugging.
# sops: required by Task #138 Phase 2A vendor-key delivery substrate
# (src/secureStore/sopsAge.js subprocess decrypt) per parch #10320 ratify of
# OQ-2(a) + secops #10319 .sops.env format canon. sops invokes age internally
# for the age-recipient layer; both binaries required in container.
RUN apk add --no-cache git age sops

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 3100

CMD ["npm", "start"]
