"""Resolve catalogue functions and signatures from the configured training checkout.

AST inspection is read-only and does not import GPU or simulator runtimes.
"""
import argparse
import ast
import hashlib
import json
import sys
from pathlib import Path


def resolve_source(root, target):
    module, name = target.split(":")
    relative = Path(*module.split("."))
    bases = [Path(root) / "src", *[Path(p) for p in sys.path if p]]
    for base in bases:
        file = (base / relative).with_suffix(".py")
        if file.is_file():
            tree = ast.parse(file.read_text())
            node = next((n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name == name), None)
            if node is None:
                raise ValueError(f"{target}: source has no such callable")
            signature = node
            if isinstance(node, ast.ClassDef):
                signature = next(n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == "__call__")
            args = signature.args
            allowed = {a.arg for a in args.posonlyargs + args.args + args.kwonlyargs} - {"self", "env"}
            required = {a.arg for a in (args.posonlyargs + args.args)[:len(args.posonlyargs + args.args) - len(args.defaults)]} - {"self", "env"}
            return file, node, allowed, required
    raise ValueError(f"Cannot locate {module} in configured training environment")


def validate(root, catalog):
    results = []
    for term in catalog["terms"]:
        try:
            file, _, allowed, required = resolve_source(root, term["function"])
            keys = set(term.get("params", {})) | set(term.get("fixed_params", {}))
            if keys - allowed:
                raise ValueError("Unknown parameters: " + ", ".join(sorted(keys - allowed)))
            if required - keys:
                raise ValueError("Missing required parameters: " + ", ".join(sorted(required - keys)))
            results.append({"id": term["id"], "ok": True, "source": str(file), "source_sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
        except Exception as exc:
            results.append({"id": term["id"], "ok": False, "error": str(exc)})
    return results


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--asset-root", required=True)
    p.add_argument("--catalog", type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(validate(a.asset_root, json.loads(a.catalog.read_text()))))
