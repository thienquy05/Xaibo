#!/bin/sh
# Writes the sha256 of stdin to the side file named by XAIBO_HASH_OUT.
shasum -a 256 | cut -c1-64 > "$XAIBO_HASH_OUT"
