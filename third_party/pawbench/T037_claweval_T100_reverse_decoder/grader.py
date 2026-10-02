import subprocess
import sys
from pathlib import Path


def grade(transcript: list, workspace_path: str) -> dict:
    result = {
        "output_file_exists": 0.0,
        "exact_match": 0.0,
        "char_match_ratio": 0.0,
        "size_within_60pct": 0.0,
        "size_within_75pct": 0.0,
        "writeup_exists": 0.0,
    }

    workspace = Path(workspace_path)
    encoded = workspace / "output" / "encoded.dat"
    decoder = workspace / "fixtures" / "decoder.py"
    target = workspace / "fixtures" / "target.txt"
    writeup = workspace / "output" / "encoder_writeup.md"

    if writeup.is_file():
        result["writeup_exists"] = 1.0

    if not encoded.is_file():
        return result
    result["output_file_exists"] = 1.0

    if not decoder.is_file() or not target.is_file():
        return result

    target_bytes = target.read_bytes()
    encoded_bytes = encoded.read_bytes()
    target_size = len(target_bytes) or 1
    ratio = len(encoded_bytes) / target_size

    if ratio <= 0.60:
        result["size_within_60pct"] = 1.0
    if ratio <= 0.75:
        result["size_within_75pct"] = 1.0

    try:
        proc = subprocess.run(
            [sys.executable, str(decoder)],
            input=encoded_bytes,
            capture_output=True,
            timeout=30,
        )
        decoded = proc.stdout
    except Exception:
        return result

    if decoded == target_bytes:
        result["exact_match"] = 1.0
        result["char_match_ratio"] = 1.0
    else:
        try:
            t_str = target_bytes.decode("utf-8", errors="replace")
            d_str = decoded.decode("utf-8", errors="replace")
        except Exception:
            t_str, d_str = "", ""
        if t_str:
            common = sum(1 for a, b in zip(t_str, d_str) if a == b)
            result["char_match_ratio"] = common / max(len(t_str), 1)

    # Cap: if size > 75% of target, the submission is invalid — zero out correctness scores
    if not result["size_within_75pct"]:
        result["exact_match"] = 0.0
        result["char_match_ratio"] = 0.0

    return result
