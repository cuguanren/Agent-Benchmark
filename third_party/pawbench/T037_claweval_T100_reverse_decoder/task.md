---
id: T100_reverse_decoder
name: Reverse-Engineer Custom Encoder
category: terminal
grading_type: automated
timeout_seconds: 900
workspace_files:
- source: assets/T037_claweval_T100_reverse_decoder/fixtures/decoder.py
  dest: fixtures/decoder.py
- source: assets/T037_claweval_T100_reverse_decoder/fixtures/target.txt
  dest: fixtures/target.txt
labels:
  capabilities:
  - Logic_Reasoning
  - Code_Manipulation
  - Tool_Use
  - Self_Verification
  modality:
    type: text
    channels: []
  scenario: Software_Engineering/Code
  complexity: L3
  environment: closed
---
## Prompt

Workspace files:
- `fixtures/decoder.py` — reads encoded binary from stdin, writes decoded text to stdout
- `fixtures/target.txt` — desired output text

Your goal: produce `output/encoded.dat` such that:
```
python fixtures/decoder.py < output/encoded.dat
```
produces output that **exactly matches** `fixtures/target.txt`.

**Size constraint**: `output/encoded.dat` must be at most **60% the size** of `fixtures/target.txt` in bytes.

To document your approach, also save a short write-up to `output/encoder_writeup.md` explaining how the encoder reverses the decoder pipeline.

## Expected Behavior

The decoder uses a 3-stage pipeline (in decode order):
1. Parse 4-byte header (interleaved bytes for `n` and `seed`)
2. XOR mask each byte with `((seed*(i+1)+165) & 0xFF)` — self-inverse
3. Block de-interleave (16-byte blocks)
4. Bitstream decode with prefix codes (RLE + escapes)

To produce a valid `encoded.dat` the agent must reverse all stages and stay under the size budget.

## Grading Criteria

- [ ] `output/encoded.dat` exists (output_file_exists)
- [ ] Decoder run on `encoded.dat` produces `target.txt` exactly (exact_match)
- [ ] `encoded.dat` size ≤ 60% of `target.txt` size (size_within_60pct)
- [ ] (partial) size ≤ 75% of `target.txt` size (size_within_75pct)
- [ ] Write-up `output/encoder_writeup.md` exists (writeup_exists)

## Automated Checks

```python
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
```

## Reference: Write-up Quality Criteria (for human review only)

The `output/encoder_writeup.md` should ideally:
- Identify all decoder stages (header parsing, XOR mask, block interleave, bitstream prefix codes, RLE)
- Explain how each stage is reversed by the encoder
- Note the size budget and any compression strategy used
- Acknowledge edge cases (escape codes, EOS marker)

*(This section is documentation only — scoring is 100% automated via the grade() function above.)*
