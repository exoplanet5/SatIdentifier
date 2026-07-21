#!/usr/bin/env python3
"""Strip stray trailing XML-ish tags from source files.

A tool artifact occasionally appends literal closing tags to a written file, which
makes it fail to parse. It lives on the very last line, so it is easy to miss and
cheap to fix. Idempotent -- safe to re-run.

Note the artifact usually appends SEVERAL tags in sequence. The loop peels them one
at a time, so every tag that can appear LAST must be listed, or nothing is fixed:
the outermost tag fails to match and the loop exits on its first pass. This is why
the names are assembled from pieces below rather than written literally -- a literal
closing tag in a source file is exactly the thing that trips the writer.

Usage: python3 tools/strip_stray_tags.py [paths...]   (default: app/, tools/, .)
"""

import pathlib
import sys

_NAMES = ('content', 'invoke', 'function_calls', 'parameter', 'file_text',
          'new_str', 'old_str', 'command')
STRAY = tuple('</' + n + '>' for n in _NAMES)
SUFFIXES = {'.js', '.py', '.css', '.html', '.md', '.json'}


def clean(path):
    """Remove trailing stray tags. Returns True if the file was modified."""
    try:
        text = path.read_text(encoding='utf-8')
    except (UnicodeDecodeError, OSError):
        return False
    stripped = text.rstrip()
    changed = False
    while stripped.endswith(STRAY):
        for tag in STRAY:
            if stripped.endswith(tag):
                stripped = stripped[:-len(tag)].rstrip()
                changed = True
                break
    if changed:
        path.write_text(stripped + '\n', encoding='utf-8')
    return changed


def main():
    roots = [pathlib.Path(a) for a in sys.argv[1:]] or [
        pathlib.Path('app'), pathlib.Path('tools'), pathlib.Path('.')]
    seen = set()
    fixed = []
    for root in roots:
        files = [root] if root.is_file() else sorted(root.rglob('*'))
        for f in files:
            if f in seen or not f.is_file() or f.suffix not in SUFFIXES:
                continue
            if 'vendor' in f.parts or 'node_modules' in f.parts:
                continue
            seen.add(f)
            if clean(f):
                fixed.append(f)
    for f in fixed:
        print('stripped stray tag: %s' % f, flush=True)
    print('checked %d files, fixed %d' % (len(seen), len(fixed)), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
