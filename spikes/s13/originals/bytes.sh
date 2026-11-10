#!/bin/sh
# Fixed stdout with ANSI escapes, invalid UTF-8 (0xff 0xfe 0x80) and no trailing newline; fixed stderr.
printf '\033[1;32mXAIBO-ORIG\033[0m \377\376 caf\303\251 \200end'
printf 'orig-stderr\n' >&2
