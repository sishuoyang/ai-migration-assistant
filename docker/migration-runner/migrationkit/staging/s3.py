"""
S3 staging primitives — credential / bucket holder plus minimal boto3
helpers for listing and deleting per-run prefixes.

`boto3` is imported lazily inside the helpers so direct-path migrations
(the common case in this playground) don't pay the import cost.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass  # boto3 stays out of the type graph


@dataclass(frozen=True)
class S3Stage:
    """Where staged Parquet files live, and the AWS creds used to write
    them. Same creds are passed to ClickHouse's s3() table function on
    the read side, so the stage is a single source of truth for the
    whole staging path."""

    bucket: str
    region: str
    access_key_id: str
    secret_access_key: str
    prefix: str = "migrationkit"

    @classmethod
    def from_env(cls) -> "S3Stage":
        """Read `STAGING_S3_*` env vars. Raises with a clear message if
        any required value is missing — partners should be steered to
        docs/object-storage-staging.md."""
        try:
            return cls(
                bucket=os.environ["STAGING_S3_BUCKET"],
                region=os.environ["STAGING_S3_REGION"],
                access_key_id=os.environ["STAGING_S3_ACCESS_KEY_ID"],
                secret_access_key=os.environ["STAGING_S3_SECRET_ACCESS_KEY"],
                prefix=os.environ.get("STAGING_S3_PREFIX", "migrationkit"),
            )
        except KeyError as missing:
            raise RuntimeError(
                f"S3Stage.from_env(): missing env var {missing}. Set "
                "STAGING_S3_BUCKET, STAGING_S3_REGION, "
                "STAGING_S3_ACCESS_KEY_ID, STAGING_S3_SECRET_ACCESS_KEY "
                "(STAGING_S3_PREFIX optional). See "
                "docs/object-storage-staging.md."
            ) from None

    def s3_uri(self, run_id: str, table: str) -> str:
        """`s3://<bucket>/<prefix>/<run_id>/<table>/` — trailing slash so
        downstream callers can append filenames. Both run_id and table
        are URL-safe by convention (kebab/underscore) so no escaping."""
        # Strip leading/trailing slashes from prefix to avoid double-slashes
        # when prefix is "" or "foo/".
        clean_prefix = self.prefix.strip("/")
        parts = [p for p in [clean_prefix, run_id, table] if p]
        return f"s3://{self.bucket}/{'/'.join(parts)}/"

    def s3_glob(self, run_id: str, table: str, file_format: str = "parquet") -> str:
        """URI with wildcard suffix for ClickHouse's s3() table
        function: e.g. s3://bucket/migrationkit/run/table/*.parquet."""
        ext = file_format.lower()
        return self.s3_uri(run_id, table).rstrip("/") + f"/*.{ext}"

    def key_prefix(self, run_id: str, table: str) -> str:
        """Just the key portion (no s3://<bucket>/), trailing slash —
        used for boto3 list_objects_v2 / delete_objects."""
        clean_prefix = self.prefix.strip("/")
        parts = [p for p in [clean_prefix, run_id, table] if p]
        return "/".join(parts) + "/"


@dataclass(frozen=True)
class S3Object:
    key: str
    size: int


def _client(stage: S3Stage):
    """Lazy boto3.client('s3') — imported here, not at module top, so
    direct-path migrations don't import boto3."""
    import boto3  # noqa: PLC0415

    return boto3.client(
        "s3",
        region_name=stage.region,
        aws_access_key_id=stage.access_key_id,
        aws_secret_access_key=stage.secret_access_key,
    )


def list_s3_objects(stage: S3Stage, run_id: str, table: str) -> list[S3Object]:
    """All objects under <prefix>/<run_id>/<table>/. Paginates so
    Snowflake unloads producing > 1000 part files are handled."""
    client = _client(stage)
    prefix = stage.key_prefix(run_id, table)
    out: list[S3Object] = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=stage.bucket, Prefix=prefix):
        for item in page.get("Contents", []) or []:
            out.append(S3Object(key=item["Key"], size=int(item["Size"])))
    return out


def delete_s3_prefix(stage: S3Stage, run_id: str, table: str) -> int:
    """Delete everything under the per-run-per-table prefix. Returns the
    number of objects deleted. S3 delete_objects takes at most 1000 keys
    per call, so paginate."""
    client = _client(stage)
    objects = list_s3_objects(stage, run_id, table)
    if not objects:
        return 0
    deleted = 0
    for batch_start in range(0, len(objects), 1000):
        chunk = objects[batch_start : batch_start + 1000]
        client.delete_objects(
            Bucket=stage.bucket,
            Delete={"Objects": [{"Key": o.key} for o in chunk]},
        )
        deleted += len(chunk)
    return deleted
