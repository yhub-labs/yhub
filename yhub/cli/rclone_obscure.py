"""rclone's obscure algorithm (pure Python).

**Why this file exists**: in rclone's remote config, passwords are stored *obscured* (not plaintext,
not encrypted — rclone itself says obscure only means "don't show it at a glance"). And
`rclone obscure <password>` **only takes the password on the command line**: it would show up in `ps`
output for anyone to read. We promise "password never hits disk, never enters argv", so we have to do
this step ourselves. The algorithm is the few lines in rclone's source (fs/config/obscure/obscure.go):

    obscure(x) = base64url_raw( iv(16 random bytes) || AES256CTR(x, iv) )

The key is a constant hard-coded in rclone (not a secret); AES is only used forward (CTR needs no
inverse). `reveal()` is the reverse, used for self-checks and for cross-checking `rclone reveal`.
"""

from __future__ import annotations

import base64
import os

# The 32-byte key hard-coded in rclone (cryptKey in fs/config/obscure/obscure.go)
_KEY = bytes(
    (
        0x9C, 0x93, 0x5B, 0x48, 0x73, 0x0A, 0x55, 0x4D,
        0x6B, 0xFD, 0x7C, 0x63, 0xC8, 0x86, 0xA9, 0x2B,
        0xD3, 0x90, 0x19, 0x8E, 0xB8, 0x12, 0x8A, 0xFB,
        0xF4, 0xDE, 0x16, 0x2B, 0x8B, 0x95, 0xF6, 0x38,
    )
)

_SBOX = bytes.fromhex(
    "637c777bf26b6fc53001672bfed7ab76"
    "ca82c97dfa5947f0add4a2af9ca472c0"
    "b7fd9326363ff7cc34a5e5f171d83115"
    "04c723c31896059a071280e2eb27b275"
    "09832c1a1b6e5aa0523bd6b329e32f84"
    "53d100ed20fcb15b6acbbe394a4c58cf"
    "d0efaafb434d338545f9027f503c9fa8"
    "51a3408f929d38f5bcb6da2110fff3d2"
    "cd0c13ec5f974417c4a77e3d645d1973"
    "60814fdc222a908846eeb814de5e0bdb"
    "e0323a0a4906245cc2d3ac629195e479"
    "e7c8376d8dd54ea96c56f4ea657aae08"
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a"
    "703eb5664803f60e613557b986c11d9e"
    "e1f8981169d98e949b1e87e9ce5528df"
    "8ca1890dbfe6426841992d0fb054bb16"
)


def _xtime(a: int) -> int:
    a <<= 1
    return (a ^ 0x1B) & 0xFF if a & 0x100 else a


def _expand_key(key: bytes) -> bytes:
    """AES-256 key expansion → 15 round keys (240 bytes; 14 rounds + the initial one)."""
    nk = 8
    words = [int.from_bytes(key[4 * i : 4 * i + 4], "big") for i in range(nk)]
    rcon = 1
    target = 4 * 15
    for i in range(nk, target):
        temp = words[i - 1]
        if i % nk == 0:
            temp = ((temp << 8) | (temp >> 24)) & 0xFFFFFFFF  # RotWord
            temp = sum(_SBOX[(temp >> (24 - 8 * k)) & 0xFF] << (24 - 8 * k) for k in range(4))
            temp ^= rcon << 24
            rcon = _xtime(rcon)
        elif i % nk == 4:
            temp = sum(_SBOX[(temp >> (24 - 8 * k)) & 0xFF] << (24 - 8 * k) for k in range(4))
        words.append((words[i - nk] ^ temp) & 0xFFFFFFFF)
    return b"".join(word.to_bytes(4, "big") for word in words)


def _sub_bytes(state: list[int]) -> list[int]:
    return [_SBOX[byte] for byte in state]


def _shift_rows(state: list[int]) -> list[int]:
    """state[4*col + row]: row r is rotated left by r."""
    out = [0] * 16
    for row in range(4):
        for col in range(4):
            out[4 * col + row] = state[4 * ((col + row) % 4) + row]
    return out


def _mix_columns(state: list[int]) -> list[int]:
    out = [0] * 16
    for col in range(4):
        a0, a1, a2, a3 = state[4 * col : 4 * col + 4]
        out[4 * col + 0] = _xtime(a0) ^ (_xtime(a1) ^ a1) ^ a2 ^ a3
        out[4 * col + 1] = a0 ^ _xtime(a1) ^ (_xtime(a2) ^ a2) ^ a3
        out[4 * col + 2] = a0 ^ a1 ^ _xtime(a2) ^ (_xtime(a3) ^ a3)
        out[4 * col + 3] = (_xtime(a0) ^ a0) ^ a1 ^ a2 ^ _xtime(a3)
    return out


def _encrypt_block(block: bytes, round_keys: bytes) -> bytes:
    """Encrypt one 16-byte block with AES-256 (forward direction)."""
    state = [block[i] ^ round_keys[i] for i in range(16)]
    for rnd in range(1, 14):
        state = _mix_columns(_shift_rows(_sub_bytes(state)))
        offset = 16 * rnd
        state = [state[i] ^ round_keys[offset + i] for i in range(16)]
    state = _shift_rows(_sub_bytes(state))
    offset = 16 * 14
    return bytes(state[i] ^ round_keys[offset + i] for i in range(16))


def _ctr(data: bytes, iv: bytes, round_keys: bytes) -> bytes:
    """AES-256-CTR: the counter is the iv read as a big-endian 128-bit int, +1 per block (matching Go's cipher.NewCTR)."""
    out = bytearray()
    counter = int.from_bytes(iv, "big")
    for offset in range(0, len(data), 16):
        stream_block = _encrypt_block(counter.to_bytes(16, "big"), round_keys)
        chunk = data[offset : offset + 16]
        out += bytes(a ^ b for a, b in zip(chunk, stream_block))
        counter = (counter + 1) & ((1 << 128) - 1)
    return bytes(out)


def obscure(text: str) -> str:
    """Plaintext → rclone's obscured form (random iv each call, so the same input gives different output)."""
    iv = os.urandom(16)
    body = text.encode("utf-8")
    return base64.urlsafe_b64encode(iv + _ctr(body, iv, _expand_key(_KEY))).decode().rstrip("=")


def reveal(text: str) -> str:
    """Obscured → plaintext (used for self-checks). Raises ValueError if the input is not obscured."""
    padded = text + "=" * (-len(text) % 4)
    raw = base64.urlsafe_b64decode(padded.encode())
    if len(raw) < 16:
        raise ValueError("input too short when revealing password - is it obscured?")
    iv, body = raw[:16], raw[16:]
    return _ctr(body, iv, _expand_key(_KEY)).decode("utf-8", "strict")


def looks_obscured(text: str) -> bool:
    """Whether this looks like an already-obscured value: it reveals to printable text.

    Display hint only, never a decision.
    """
    try:
        plain = reveal(text)
    except (ValueError, UnicodeDecodeError, base64.binascii.Error):
        return False
    return all(ch.isprintable() or ch == "\t" for ch in plain)
