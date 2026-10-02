"""Limited Python tool for the closed decoder task; not an OS container."""
import ast
import builtins
import io
import json
import pathlib
import sys

payload = json.loads(sys.stdin.read())
root = pathlib.Path(payload["root"]).resolve()
script = (root / payload["script"]).resolve()
script.relative_to(root)
source = script.read_text(encoding="utf-8")
tree = ast.parse(source, filename=str(script))
modules = {"sys", "struct", "math", "json", "base64", "collections", "itertools", "functools", "zlib", "io", "binascii"}
blocked = {"eval", "exec", "compile", "globals", "locals", "vars", "getattr", "setattr", "delattr", "__builtins__", "breakpoint", "input", "help"}
for node in ast.walk(tree):
    if isinstance(node, ast.Name) and node.id in blocked:
        raise ValueError("unsupported Python capability")
    if isinstance(node, ast.Attribute) and (node.attr.startswith("_") or node.attr in {"modules", "meta_path", "path_hooks"}):
        raise ValueError("unsupported introspection")
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
        if any(name.split(".")[0] not in modules for name in names):
            raise ValueError("unsupported import")
        if isinstance(node, ast.ImportFrom) and any(a.name.startswith("_") or a.name in {"modules", "meta_path", "path_hooks"} for a in node.names):
            raise ValueError("unsupported introspection import")

real_open = builtins.open
real_import = builtins.__import__

def workspace_open(file, mode="r", *args, **kwargs):
    if not isinstance(file, (str, bytes, pathlib.Path)):
        raise ValueError("file descriptors unavailable")
    target = (root / file).resolve()
    relative = target.relative_to(root)
    if any(flag in mode for flag in "wax+") and relative.parts[0].lower() == "fixtures":
        raise ValueError("fixtures are read-only")
    return real_open(target, mode, *args, **kwargs)

def safe_import(name, *args, **kwargs):
    if name.split(".")[0] not in modules:
        raise ValueError("unsupported import")
    return real_import(name, *args, **kwargs)

io.open = workspace_open
names = "abs all any bin bool bytearray bytes chr dict divmod enumerate Exception float format hex int isinstance len list map max min next oct ord pow print range repr reversed round set slice sorted str sum tuple ValueError TypeError RuntimeError OSError IndexError KeyError StopIteration zip".split()
safe = {name: getattr(builtins, name) for name in names}
safe["open"] = workspace_open
safe["__import__"] = safe_import
exec(compile(tree, str(script), "exec"), {"__builtins__": safe, "__name__": "__main__", "__file__": str(script)})
