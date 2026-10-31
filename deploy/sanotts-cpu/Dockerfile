# Build context is the local package produced by scripts/build-sanotts-cpu.sh.
# The Ubuntu base and package repository snapshot are pinned for repeatability.
FROM ubuntu:24.04@sha256:78d4744ead1f5b19b04d0df558ab182a5300903900755e515b2ca4d10eb2044d

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; \
    printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/20261030T000000Z noble main universe' \
      'deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/20261030T000000Z noble-updates main universe' \
      'deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/20261030T000000Z noble-security main universe' \
      > /etc/apt/sources.list; \
    apt-get -o Acquire::Check-Valid-Until=false update; \
    apt-get install -y --no-install-recommends \
      bash ca-certificates curl python3 libgomp1 libstdc++6; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY audio.cpp-hub /usr/local/bin/audio.cpp-hub
COPY web/ ./web/
COPY docker/hub.config.json ./hub.config.json
COPY docker/executables.json ./executables.json
COPY docker/start-hub.sh /usr/local/bin/start-hub.sh
COPY docker/start-instance.sh /usr/local/bin/start-instance.sh
COPY bin/ /audio.cpp/bin/
COPY licenses/ /usr/share/licenses/audio.cpp-hub/
COPY source/ /usr/share/doc/audio.cpp-hub/source/

RUN chmod 0755 /usr/local/bin/audio.cpp-hub \
               /usr/local/bin/start-hub.sh \
               /usr/local/bin/start-instance.sh

ENV LD_LIBRARY_PATH=/audio.cpp/bin:/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu
ENV AUDIOCPP_SERVER_BIN=/audio.cpp/bin/audiocpp_server

EXPOSE 18080
ENTRYPOINT ["/usr/local/bin/start-hub.sh"]
