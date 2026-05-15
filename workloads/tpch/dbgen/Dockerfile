# tpch-dbgen — generates TPC-H .tbl files at a given scale factor.
#
# The official TPC sources (https://www.tpc.org/tpch/) require a
# clickwrap agreement, so this image builds from the widely-used
# unofficial mirror that has been packaged for benchmark reproducibility.
# If the partner needs licence-clean dbgen, replace the git clone below
# with their own internal source.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN git clone --depth 1 https://github.com/electrum/tpch-dbgen.git
WORKDIR /opt/tpch-dbgen
RUN make 1>/dev/null

COPY generate.sh /generate.sh
RUN chmod +x /generate.sh

# /data is the mount point the host bind-mounts to workloads/tpch/data.
VOLUME ["/data"]
ENTRYPOINT ["/generate.sh"]
CMD ["1"]
