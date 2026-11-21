#!/usr/bin/env python3
"""Plants one entry of plants.json into a tree, or puts it back.

Usage: plant.py <plants.json> <tree-dir> <name> apply|restore
apply: each [file, old, new, count] edit, `old` matching exactly `count`
times; the files are saved first. restore: the saved files are written back
and checked by sha256 against the saved bytes.
"""
import hashlib
import json
import os
import sys


def main():
    spec, root, name, step = sys.argv[1:5]
    plant = next(p for p in json.load(open(spec)) if p["name"] == name)
    save = os.path.join(root, ".plant-saved")
    os.makedirs(save, exist_ok=True)
    for path, old, new, count in plant["edits"]:
        full = os.path.join(root, path)
        keep = os.path.join(save, path.replace("/", "_"))
        if step == "apply":
            with open(full, "rb") as f:
                data = f.read()
            if not os.path.exists(keep):
                with open(keep, "wb") as f:
                    f.write(data)
            text = data.decode()
            found = text.count(old)
            if found != count:
                print(f"Error: {name}: {path}: {found} matches, not {count}")
                return 3
            with open(full, "w") as f:
                f.write(text.replace(old, new))
            print(f"PLANT {name} {path}: {count} edit(s) ({plant['what']})")
        elif os.path.exists(keep):
            with open(keep, "rb") as f:
                data = f.read()
            with open(full, "wb") as f:
                f.write(data)
            with open(full, "rb") as f:
                now = hashlib.sha256(f.read()).hexdigest()
            want = hashlib.sha256(data).hexdigest()
            print(f"RESTORED {name} {path} sha256 {want[:16]} {'ok' if now == want else 'MISMATCH ' + now[:16]}")
            os.remove(keep)
            if now != want:
                return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
