#!/usr/bin/env bash
# Generate TPC-H .tbl files at the given scale factor into /data/sf<N>/.
#
# Usage (inside container):  /generate.sh <scale-factor>
# Default scale factor: 1 (≈ 6M rows total, ~1 GB)
#
# Outputs:
#   /data/sf<N>/region.tbl
#   /data/sf<N>/nation.tbl
#   /data/sf<N>/supplier.tbl
#   /data/sf<N>/part.tbl
#   /data/sf<N>/partsupp.tbl
#   /data/sf<N>/customer.tbl
#   /data/sf<N>/orders.tbl
#   /data/sf<N>/lineitem.tbl
#
# Idempotent: if /data/sf<N>/lineitem.tbl already exists, the script exits
# without regenerating.
set -euo pipefail

SCALE="${1:-1}"
OUT_DIR="/data/sf${SCALE}"

if [ -f "${OUT_DIR}/lineitem.tbl" ]; then
    echo "✅ /data/sf${SCALE} already populated — skipping."
    exit 0
fi

mkdir -p "${OUT_DIR}"
cd /opt/tpch-dbgen

# dbgen writes .tbl files into the current directory. Run inside the
# build dir, then move outputs into the scaled output dir.
./dbgen -vf -s "${SCALE}"

mv -- *.tbl "${OUT_DIR}/"
echo "✅ Generated TPC-H SF${SCALE} into ${OUT_DIR}"
ls -lh "${OUT_DIR}"
