# Safety Radar – runtime image for the daily run (stage 1 + e-mail intake + reviewer). The repository is mounted at
# /app (see docker-compose.yml) so git, the review worktrees and the gitignored working state persist on the host.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils git ca-certificates tzdata rsync openssh-client curl gnupg util-linux \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
ENV TZ=Europe/Zurich NOINDEX=1 SITE=https://safetyradar.ch BASE=/
# node user (uid 1000) owns the mounted checkout on the host; git must accept it.
RUN git config --system --add safe.directory /app
USER node
WORKDIR /app
CMD ["deploy/run-daily.sh"]
