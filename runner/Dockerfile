# InterviewIQ code runner. Build from the runner/ directory: docker build -t iq-runner runner
FROM node:24-bookworm-slim AS launcher
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libseccomp-dev && rm -rf /var/lib/apt/lists/*
COPY sandbox/iq-sandbox.c /src/iq-sandbox.c
RUN gcc -O2 -Wall -Wextra -Werror -o /iq-sandbox /src/iq-sandbox.c -lseccomp

FROM node:24-bookworm-slim
# openjdk's post-install script expects the man page directory, which slim images omit.
RUN mkdir -p /usr/share/man/man1 \
  && apt-get update && apt-get install -y --no-install-recommends python3 g++ openjdk-17-jdk-headless libseccomp2 procps tini \
  && rm -rf /var/lib/apt/lists/*
# A precompiled <bits/stdc++.h> keeps C++ compiles to about a second; the flags must match runner.mjs.
RUN mkdir -p /opt/iq/pch && echo '#include <bits/stdc++.h>' > /opt/iq/pch/stdc++.h \
  && g++ -std=c++17 -O2 -pipe -x c++-header /opt/iq/pch/stdc++.h -o /opt/iq/pch/stdc++.h.gch \
  && chmod -R a+rX /opt/iq
COPY --from=launcher /iq-sandbox /usr/local/bin/iq-sandbox
# Run directories live under a root-owned directory the sandbox user cannot list.
RUN chmod 0755 /usr/local/bin/iq-sandbox && mkdir -m 0711 /sandbox
WORKDIR /app
COPY package.json runner.mjs server.mjs ./
COPY test ./test
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# tini is PID 1 so processes orphaned by sandboxed code are reaped instead of piling up as zombies.
# The server starts as root so it can drop each program to the sandbox user (65534); it holds no secrets.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
