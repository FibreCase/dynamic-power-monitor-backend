"""Shared wire protocol between the ESP32 firmware and this backend.

Kept in one place so the 20-byte upstream sample and the 8-byte downstream
control packet are defined (and tested) exactly once. Must stay in sync with
the ESP32 firmware (see main/app_main.c) and TASK.md.
"""
from __future__ import annotations

import struct

# --- Upstream sample: ESP32 -> host, fixed 20 bytes (little-endian) --------
# AA 55 | u64 timestamp_ms | f32 voltage(V) | f32 current(mA) | u16 checksum
# checksum = sum of the first 18 bytes & 0xFFFF
SAMPLE_FORMAT = "<2sQffH"
SAMPLE_SIZE = struct.calcsize(SAMPLE_FORMAT)          # 20
SAMPLE_HEADER = b"\xaa\x55"
SAMPLE_CKSUM_OFFSET = SAMPLE_SIZE - 2                 # checksum is the last 2 bytes
CKSUM_OFFSET = SAMPLE_CKSUM_OFFSET                     # alias

# --- Downstream control: host -> ESP32, fixed 8 bytes (little-endian) ------
# BB 66 | u8 cmd=0x01 | u8 len=0x02 | u16 interval_ms | u16 checksum
# checksum = sum of the first 6 bytes & 0xFFFF
CONTROL_FORMAT = "<BBBBHH"
CONTROL_SIZE = struct.calcsize(CONTROL_FORMAT)        # 8
CONTROL_HEADER = b"\xbb\x66"
CMD_SET_INTERVAL = 0x01
PAYLOAD_LEN_INTERVAL = 0x02

INTERVAL_FAST_MS = 100          # 10 Hz  (viewers present)
INTERVAL_SLOW_MS = 10000        # 0.1 Hz (no viewers)


def checksum(data: bytes) -> int:
    """Sum of bytes masked to 16 bits (the wire checksum)."""
    return sum(data) & 0xFFFF


def build_control_set_interval(interval_ms: int) -> bytes:
    """Pack the 8-byte 'set sampling interval' control frame."""
    # BB 66 | 01 | 02 | u16 interval_ms | u16 checksum (over the first 6 bytes)
    body = struct.pack("<BBBBH", CONTROL_HEADER[0], CONTROL_HEADER[1],
                       CMD_SET_INTERVAL, PAYLOAD_LEN_INTERVAL, interval_ms)
    return body + struct.pack("<H", checksum(body))


def parse_sample(data: bytes) -> tuple[int, float, float, float] | None:
    """Decode one 20-byte sample frame.

    Returns (dev_ts, voltage, current, power_mw) or None if the frame header or
    checksum is invalid. `data` must be exactly SAMPLE_SIZE bytes.
    """
    if len(data) != SAMPLE_SIZE:
        return None
    if data[0:2] != SAMPLE_HEADER:
        return None
    if checksum(data[:SAMPLE_CKSUM_OFFSET]) != struct.unpack("<H", data[SAMPLE_CKSUM_OFFSET:])[0]:
        return None
    _hdr, dev_ts, voltage, current, _ck = struct.unpack(SAMPLE_FORMAT, data)
    power_mw = voltage * current            # (V) * (mA) = mW
    return dev_ts, voltage, current, power_mw
