"""Read a pinned public source into ignored local storage, never stdout."""
import json
import pathlib
import sys
import pyarrow.parquet as parquet

source, destination = map(pathlib.Path, sys.argv[1:3])
rows = parquet.read_table(source).to_pylist()
destination.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
